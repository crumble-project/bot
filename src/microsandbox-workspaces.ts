import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import {
  Connection,
  RemoteExecutionEnv,
  type ConnectionOptions,
} from "@earendil-works/pi-env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Sandbox, Volume, VolumeNotFoundError } from "microsandbox";
import { z } from "zod";
import {
  WORKSPACE_PATH,
  allowAllRequests,
  type WorkspaceNetworkPolicy,
  type Workspaces,
} from "./workspace";
import { startWorkspaceProxy, type WorkspaceProxy } from "./workspace-proxy";

const BRIDGE_PATH = path.join(import.meta.dir, "workspace-bridge.ts");
const GUEST_DAEMON = "/usr/local/bin/pi-env";
const DISK_MIB = 8192;
const MEMORY_MIB = 2048;
const CPUS = 2;

/** A running workspace stops after this long without a request. */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export type MicrosandboxWorkspacesOptions = {
  idleTimeoutMs?: number;
  /** Decides each outbound connection; defaults to allowing all. */
  network?: WorkspaceNetworkPolicy;
  /** Prefix of sandbox and volume names, which are global to the Microsandbox home. */
  namePrefix?: string;
};

const DAEMON_DIRECTORY: Partial<Record<NodeJS.Architecture, string>> = {
  arm64: "arm64",
  x64: "x64",
};

const relayRequest = z.array(z.string());

/**
 * The workspaces when `CRUMBLE_WORKSPACE_IMAGE` (an OCI image reference) is set, otherwise undefined: without an image
 * there is no machine to run, so callers leave coding out rather than fail on first use.
 */
export function microsandboxWorkspacesFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: MicrosandboxWorkspacesOptions = {},
) {
  const image = env.CRUMBLE_WORKSPACE_IMAGE;

  return image ? new MicrosandboxWorkspaces(image, options) : undefined;
}

type Running = {
  sandbox: Sandbox;
  relay: Relay;
  proxy: WorkspaceProxy;
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
    private readonly owner: MicrosandboxWorkspaces,
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
      id: `microsandbox:${agentId}`,
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
      if (this.running && (await isAlive(this.running.sandbox)))
        return this.running.command;

      if (this.running) await this.teardown();

      this.running = await this.owner.boot(this.agentId);
      this.armIdleTimer();

      return this.running.command;
    });
  }

  /** Makes guest writes durable; a killed machine loses what the guest had not synced. */
  sync() {
    return this.exclusive(async () => {
      if (this.running) await flush(this.running.sandbox);
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
    const { sandbox, relay, proxy } = this.running ?? {};

    this.running = undefined;
    await relay?.close();

    try {
      if (sandbox && (await isAlive(sandbox))) await flush(sandbox);
    } finally {
      await sandbox?.stop().catch(() => undefined);
      await proxy?.close();
    }
  }
}

/**
 * Microsandbox-backed workspaces: one microVM per bot, with the bot's files on a named, journaled disk volume at
 * `/workspace`. The machine starts on the first operation and stops after `idleTimeoutMs` of inactivity; the volume
 * survives both, and image changes. Outbound TCP goes through a per-workspace proxy that asks the network policy.
 */
export class MicrosandboxWorkspaces implements Workspaces {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly idleTimeoutMs: number;
  private readonly network: WorkspaceNetworkPolicy;
  private readonly namePrefix: string;
  private readonly daemon: string;
  private closed = false;

  constructor(
    private readonly image: string,
    options: MicrosandboxWorkspacesOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.network = options.network ?? allowAllRequests;
    this.namePrefix = options.namePrefix ?? "crumble";

    const directory = DAEMON_DIRECTORY[process.arch];

    if (!directory)
      throw new Error(
        `Workspaces need an arm64 or x64 host, not ${process.arch}`,
      );

    this.daemon = path.join(
      path.dirname(
        fileURLToPath(import.meta.resolve("@earendil-works/pi-env")),
      ),
      "..",
      "bin",
      `pi-env-linux-${directory}`,
      "pi-env",
    );
  }

  /** The bot's sandbox and volume name. */
  name(agentId: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId))
      throw new Error(`Invalid agent id: ${agentId}`);

    return `${this.namePrefix}-${agentId}`;
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
    this.name(agentId);

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

    const name = this.name(agentId);

    await ensureVolume(name);

    const proxy = await startWorkspaceProxy({
      decide: ({ host, port }) => this.network({ agentId, host, port }),
    });

    let sandbox: Sandbox | undefined;
    let relay: Relay | undefined;

    try {
      // replace() also takes over the sandbox of a server that crashed or was killed.
      sandbox = await Sandbox.builder(name)
        .image(this.image)
        .cpus(CPUS)
        .memory(MEMORY_MIB)
        .volume(WORKSPACE_PATH, (mount) => mount.named(name))
        .proxy((outbound) => outbound.httpConnect(proxy.address))
        .replace()
        .create();
      await sandbox.fs().write(GUEST_DAEMON, await readFile(this.daemon));
      await run(sandbox, `chmod 755 ${GUEST_DAEMON}`);
      relay = await startRelay(sandbox);

      return {
        sandbox,
        relay,
        proxy,
        command: [process.execPath, BRIDGE_PATH, relay.socketPath],
      };
    } catch (error) {
      await relay?.close();
      await sandbox?.stop().catch(() => undefined);
      await proxy.close();
      throw error;
    }
  }
}

/** The bot's workspace volume, created on first use. Disk volumes are ext4 with a journal. */
async function ensureVolume(name: string) {
  try {
    await Volume.get(name);
  } catch (error) {
    if (!(error instanceof VolumeNotFoundError)) throw error;

    await Volume.builder(name).disk().size(DISK_MIB).create();
  }
}

const isAlive = (sandbox: Sandbox) =>
  sandbox.ping().then(
    () => true,
    () => false,
  );

async function run(sandbox: Sandbox, command: string) {
  const result = await sandbox.exec("/bin/sh", ["-c", command]);

  if (!result.success)
    throw new Error(`${command} failed: ${result.stderr() || result.stdout()}`);
}

const flush = (sandbox: Sandbox) => run(sandbox, "sync");

/**
 * A unix socket that runs the daemon in the guest per connection: only this process can run commands in the sandbox,
 * so the `Connection` command is a bridge process that talks to this relay.
 */
async function startRelay(sandbox: Sandbox): Promise<Relay> {
  const dir = await mkdtemp(path.join(tmpdir(), "crumble-workspace-"));
  const socketPath = path.join(dir, "relay.sock");
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    serveRelayConnection(sandbox, socket);
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
function serveRelayConnection(sandbox: Sandbox, socket: net.Socket) {
  let pending = Buffer.alloc(0);

  const onFirstData = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);

    const newline = pending.indexOf(10);

    if (newline < 0) return;

    socket.off("data", onFirstData);
    socket.pause();

    const args = daemonArgs(pending.subarray(0, newline).toString());

    if (!args) return socket.destroy();

    pipeDaemon(sandbox, socket, args, pending.subarray(newline + 1)).catch(() =>
      socket.destroy(),
    );
  };

  socket.on("data", onFirstData);
}

async function pipeDaemon(
  sandbox: Sandbox,
  socket: net.Socket,
  args: string[],
  rest: Buffer,
) {
  const daemon = await sandbox.execStreamWith(GUEST_DAEMON, (options) =>
    options.args(args).stdinPipe(),
  );

  const stdin = await daemon.takeStdin();

  if (!stdin) throw new Error("The pi-env daemon has no stdin");

  // Writes to the guest are async; chaining keeps them in order.
  let writes = Promise.resolve();

  const enqueue = (write: () => Promise<void>) => {
    writes = writes.then(write).catch(() => void socket.destroy());
  };

  if (rest.length) enqueue(() => stdin.write(rest));
  socket.on("data", (data: Buffer) => enqueue(() => stdin.write(data)));
  socket.on("end", () => enqueue(() => stdin.close()));
  socket.on("close", () => enqueue(() => stdin.close()));
  socket.resume();

  for await (const event of daemon)
    if (event.kind === "stdout") socket.write(event.data);

  socket.end();
}
