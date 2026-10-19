import { execFile } from "node:child_process";
import net from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { VM, createHttpHooks } from "@earendil-works/gondolin";
import {
  Connection,
  RemoteExecutionEnv,
  type ConnectionOptions,
} from "@earendil-works/pi-env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { z } from "zod";
import {
  WORKSPACE_PATH,
  allowAllRequests,
  type WorkspaceNetworkPolicy,
  type Workspaces,
} from "./workspace";

const execFileAsync = promisify(execFile);

const BRIDGE_PATH = path.join(import.meta.dir, "gondolin-bridge.ts");
const GUEST_DAEMON = "/usr/local/bin/pi-env";
const DISK_SIZE = "8G";

/** A running workspace stops after this long without a request. */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export type GondolinWorkspacesOptions = {
  idleTimeoutMs?: number;
  /** Decides each outbound HTTP(S) request; defaults to allowing all. */
  network?: WorkspaceNetworkPolicy;
};

const manifest = z.object({
  buildId: z.string().min(1),
  config: z.object({ arch: z.enum(["aarch64", "x86_64"]) }),
});

const DAEMON_DIRECTORY = { aarch64: "arm64", x86_64: "x64" } as const;

const relayRequest = z.array(z.string());

/**
 * The workspaces when `CRUMBLE_WORKSPACE_IMAGE` (a Gondolin image directory) is set, otherwise undefined: without an
 * image there is no machine to run, so callers leave coding out rather than fail on first use.
 */
export function gondolinWorkspacesFromEnv(
  root: string,
  env: Record<string, string | undefined> = process.env,
  options: GondolinWorkspacesOptions = {},
) {
  const imagePath = env.CRUMBLE_WORKSPACE_IMAGE;

  return imagePath
    ? new GondolinWorkspaces(root, imagePath, options)
    : undefined;
}

type Running = {
  vm: VM;
  relay: Relay;
  command: readonly string[];
};

type Relay = {
  socketPath: string;
  close(): Promise<void>;
};

type Activity = {
  begin(): void;
  end(): void;
};

/** Reports each request, so the workspace knows when it is idle. */
class TrackedConnection extends Connection {
  constructor(
    options: ConnectionOptions,
    private readonly activity: Activity,
  ) {
    super(options);
  }

  override async request(...args: Parameters<Connection["request"]>) {
    this.activity.begin();

    try {
      return await super.request(...args);
    } finally {
      this.activity.end();
    }
  }
}

class Workspace {
  readonly connection: Connection;
  readonly env: ExecutionEnv;
  running: Running | undefined;
  private inflight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly owner: GondolinWorkspaces,
    readonly agentId: string,
    private readonly idleTimeoutMs: number,
  ) {
    this.connection = new TrackedConnection(
      { command: () => this.ensureStarted() },
      {
        begin: () => {
          this.inflight += 1;
          clearTimeout(this.idleTimer);
        },
        end: () => {
          this.inflight -= 1;
          this.armIdleTimer();
        },
      },
    );
    this.env = new RemoteExecutionEnv({
      connection: this.connection,
      id: `gondolin:${agentId}`,
      cwd: WORKSPACE_PATH,
    });
  }

  /** Start and stop never overlap, and concurrent callers share one start. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);

    return result;
  }

  ensureStarted() {
    return this.exclusive(async () => {
      if (this.running && this.running.vm.getHostPid() !== null)
        return this.running.command;

      if (this.running) await this.teardown();

      this.running = await this.owner.boot(this.agentId);
      this.armIdleTimer();

      return this.running.command;
    });
  }

  /** Makes guest writes durable; `vm.close()` kills QEMU without flushing. */
  sync() {
    return this.exclusive(async () => {
      if (this.running) await flush(this.running.vm);
    });
  }

  /** Stops only an idle workspace unless forced. */
  stop(force: boolean) {
    clearTimeout(this.idleTimer);

    return this.exclusive(async () => {
      // pi-env's Connection reconnects after losing its bridge but not after close(), so only the last stop closes it.
      if (force) this.connection.close();

      if (!this.running || (!force && this.inflight > 0)) return;

      await this.teardown();
    });
  }

  private armIdleTimer() {
    clearTimeout(this.idleTimer);

    if (!this.running || this.inflight > 0) return;

    this.idleTimer = setTimeout(
      () => void this.stop(false).catch(() => undefined),
      this.idleTimeoutMs,
    );
    this.idleTimer.unref();
  }

  private async teardown() {
    const { vm, relay } = this.running ?? {};

    this.running = undefined;
    await relay?.close();

    if (!vm) return;

    try {
      if (vm.getHostPid() !== null) await flush(vm);
    } finally {
      await vm.close();
    }
  }
}

/**
 * Gondolin-backed workspaces: one QEMU micro-VM per bot on a persistent qcow2 disk. The machine starts on the first
 * operation and stops after `idleTimeoutMs` of inactivity; the disk survives both. Its HTTP(S) requests go through the
 * network policy; other traffic and private address ranges are blocked.
 */
export class GondolinWorkspaces implements Workspaces {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly idleTimeoutMs: number;
  private readonly network: WorkspaceNetworkPolicy;
  private readonly image: { buildId: string; daemon: string };
  private readonly imagePath: string;
  private closed = false;

  constructor(
    private readonly root: string,
    imagePath: string,
    options: GondolinWorkspacesOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.network = options.network ?? allowAllRequests;
    // qemu-img resolves a relative backing file against the disk's directory, not the working directory.
    this.imagePath = path.resolve(imagePath);

    const { buildId, config } = manifest.parse(
      JSON.parse(
        readFileSync(path.join(this.imagePath, "manifest.json"), "utf8"),
      ),
    );

    this.image = {
      buildId,
      daemon: path.join(
        path.dirname(
          fileURLToPath(import.meta.resolve("@earendil-works/pi-env")),
        ),
        "..",
        "bin",
        `pi-env-linux-${DAEMON_DIRECTORY[config.arch]}`,
        "pi-env",
      ),
    };
  }

  diskPath(agentId: string) {
    if (!agentId || agentId !== path.basename(agentId))
      throw new Error(`Invalid agent id: ${agentId}`);

    return path.join(this.root, agentId, "disk.qcow2");
  }

  env(agentId: string) {
    return this.workspace(agentId).env;
  }

  async sync(agentId: string, _context?: Context) {
    await this.workspaces.get(agentId)?.sync();
  }

  async close(_context?: Context) {
    this.closed = true;
    await Promise.all(
      [...this.workspaces.values()].map((workspace) => workspace.stop(true)),
    );
  }

  private workspace(agentId: string) {
    this.diskPath(agentId);

    let workspace = this.workspaces.get(agentId);

    if (!workspace) {
      workspace = new Workspace(this, agentId, this.idleTimeoutMs);
      this.workspaces.set(agentId, workspace);
    }

    return workspace;
  }

  /** Boots the bot's machine with the daemon uploaded and a relay for it; called by `Workspace`, serialized per bot. */
  async boot(agentId: string): Promise<Running> {
    if (this.closed) throw new Error("Workspaces are closed");

    const diskPath = await this.prepareDisk(agentId);
    const vm = await this.createVm(diskPath, agentId);
    let relay: Relay | undefined;

    try {
      await prepareGuest(vm, this.image.daemon);
      relay = await startRelay(vm);

      return {
        vm,
        relay,
        command: [process.execPath, BRIDGE_PATH, relay.socketPath],
      };
    } catch (error) {
      await relay?.close();
      await vm.close().catch(() => undefined);
      throw error;
    }
  }

  /** Without an agent the machine has no network, as when preparing a disk. */
  private createVm(diskPath: string, agentId?: string) {
    // Private ranges stay blocked by default: the host's network and cloud metadata are not the internet.
    const network =
      agentId === undefined
        ? undefined
        : createHttpHooks({
            isRequestAllowed: (request) =>
              this.network({
                agentId,
                method: request.method,
                url: request.url,
              }),
          }).httpHooks;

    return VM.create({
      httpHooks: network,
      sandbox: {
        imagePath: this.imagePath,
        rootDiskPath: diskPath,
        rootDiskFormat: "qcow2",
        // Explicit so a host without hardware acceleration fails instead of silently emulating.
        accel: process.platform === "darwin" ? "hvf" : "kvm",
        netEnabled: network !== undefined,
      },
    });
  }

  /** The bot's disk, created on first use; a disk only boots with the image it was created from. */
  private async prepareDisk(agentId: string) {
    const diskPath = this.diskPath(agentId);
    const identityPath = path.join(path.dirname(diskPath), "image-build-id");

    await mkdir(path.dirname(diskPath), { recursive: true });

    const recorded = await readFile(identityPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );

    if (recorded === undefined || !(await exists(diskPath))) {
      await this.createDisk(diskPath, identityPath);
    } else if (recorded.trim() !== this.image.buildId) {
      throw new Error(
        `Workspace disk for ${agentId} was created from image ${recorded.trim()}, but the configured image is ${this.image.buildId}. Workspace migration is not supported yet.`,
      );
    }

    return diskPath;
  }

  private async createDisk(diskPath: string, identityPath: string) {
    const partial = `${diskPath}.partial`;

    await rm(partial, { force: true });
    await execFileAsync("qemu-img", [
      "create",
      "-q",
      "-f",
      "qcow2",
      "-b",
      path.join(this.imagePath, "rootfs.ext4"),
      "-F",
      "raw",
      partial,
      DISK_SIZE,
    ]);

    // The image's ext4 has no journal, which a hard stop would leave unrecoverable.
    const vm = await this.createVm(partial);

    try {
      await run(vm, "tune2fs -O has_journal /dev/vda");
      await flush(vm);
    } finally {
      await vm.close();
    }

    await writeFile(identityPath, this.image.buildId);
    await rename(partial, diskPath);
  }
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

async function run(vm: VM, command: string) {
  const result = await vm.exec(["/bin/sh", "-c", command]);

  if (!result.ok)
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
}

const flush = (vm: VM) => run(vm, "sync");

async function prepareGuest(vm: VM, daemonPath: string) {
  await vm.fs.mkdir(path.dirname(GUEST_DAEMON), { recursive: true });
  await vm.fs.writeFile(GUEST_DAEMON, await readFile(daemonPath));
  await run(vm, `chmod 755 ${GUEST_DAEMON} && mkdir -p ${WORKSPACE_PATH}`);
}

/**
 * A unix socket that runs the daemon in the guest per connection: Gondolin execs only from this process, so the
 * `Connection` command is a bridge process that talks to this relay.
 */
async function startRelay(vm: VM): Promise<Relay> {
  const dir = await mkdtemp(path.join(tmpdir(), "crumble-workspace-"));
  const socketPath = path.join(dir, "relay.sock");
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    serveRelayConnection(vm, socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  return {
    socketPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// A throw here would escape the socket's event handler and take the server down.
function daemonArgs(line: string): string[] | undefined {
  try {
    return relayRequest.safeParse(JSON.parse(line)).data;
  } catch {
    return undefined;
  }
}

/** The first line is the daemon's arguments as JSON; the rest is its stdin. */
function serveRelayConnection(vm: VM, socket: net.Socket) {
  let pending = Buffer.alloc(0);

  const onFirstData = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);

    const newline = pending.indexOf(10);

    if (newline < 0) return;

    socket.off("data", onFirstData);

    const args = daemonArgs(pending.subarray(0, newline).toString());

    if (!args) return socket.destroy();

    const daemon = vm.exec([GUEST_DAEMON, ...args], {
      stdin: true,
      stdout: "pipe",
      stderr: "pipe",
    });

    daemon.stdout?.pipe(socket);
    daemon.stderr?.resume();
    daemon.write(pending.subarray(newline + 1));
    socket.on("data", (data) => daemon.write(data));
    socket.on("end", () => daemon.end());
    socket.on("close", () => daemon.end());
    daemon.result.then(
      () => socket.end(),
      () => socket.destroy(),
    );
  };

  socket.on("data", onFirstData);
}
