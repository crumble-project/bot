import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  RemoteExecutionEnv,
  type ConnectionOptions,
} from "@earendil-works/pi-env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Effect } from "effect";
import { z } from "zod";
import {
  BotDesktopImageMissing,
  BotDesktopNotConfigured,
  InvalidAgentId,
  WorkspaceConfigFailed,
  WorkspacesClosed,
  WORKSPACE_PATH,
  bootFailure,
  desktopStartFailure,
  desktopStreamFailure,
  isWorkspaceFailure,
  stopFailure,
  syncFailure,
  type DesktopStream,
  type WorkspaceFailure,
  type WorkspaceService,
} from "./workspace";
import type { WorkspaceInterceptor } from "./workspace-proxy";

const BRIDGE_PATH = path.join(import.meta.dir, "workspace-bridge.ts");

/** Where every backend puts the pi-env daemon in the guest. */
export const GUEST_DAEMON = "/usr/local/bin/pi-env";

/** Started at boot on a desktop image, not through pi-env: its daemon kills what it started when the connection closes. */
export const DESKTOP_START = "/opt/crumble/desktop-start.sh";

/** Makes `DESKTOP_START` return once the VNC server listens, before the browser is up. */
export const DESKTOP_DISPLAY_ONLY = "--display";

/** A running workspace stops after this long without a request. */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** A guest program's stdin and stdout as a byte stream. */
export type MachineStream = {
  write(data: Uint8Array): Promise<void>;
  /** Closes the program's stdin. */
  end(): Promise<void>;
  output: AsyncIterable<Uint8Array>;
};

/** A booted machine behind one bot's workspace. */
export interface WorkspaceMachine {
  /** The image it booted. */
  readonly image: string;
  isAlive(): Promise<boolean>;
  /** Resolves once the bot desktop's browser is up; at once on an image without a bot desktop. */
  desktopReady(): Promise<void>;
  stream(command: string, args: readonly string[]): Promise<MachineStream>;
  /** Makes completed writes in the workspace durable. */
  sync(): Promise<void>;
  /** Makes the workspace durable while the machine still runs, then stops it and frees what it held. */
  stop(): Promise<void>;
}

/** What a booted guest gets besides the daemon. */
export type GuestSetup = {
  /** The bot's credential proxy authority in PEM, to trust at `GUEST_CA_PATH`. */
  caCertificate?: string | undefined;
};

/** A backend that boots workspace machines. */
export interface WorkspaceMachines {
  /** Prefix of pi-env environment ids. */
  readonly kind: string;
  /** Variables that send a job's HTTPS through the workspace proxy, where the guest does not reach it on its own. */
  readonly proxyEnv?: Record<string, string>;
  /**
   * Boots the bot's machine on `image` with the daemon at `GUEST_DAEMON`. On a desktop image the bot desktop's VNC
   * server already listens; its browser may still be starting. Called serialized per bot.
   */
  boot(
    agentId: string,
    image: string,
    guest?: GuestSetup,
  ): Promise<WorkspaceMachine>;
}

export type MachineWorkspacesOptions = {
  idleTimeoutMs?: number;
  /** The image for bots with a bot desktop: the base image plus the desktop. */
  desktopImage?: string;
  /** Whether the bot needs its bot desktop; read at each boot. */
  wantsDesktop?: (agentId: string) => boolean;
  /** The bot's credential proxy authority, installed at every boot. */
  caCertificate?: (agentId: string) => Promise<string>;
  /** Takes over the bot's TLS connections to its credential hosts. */
  intercept?: (agentId: string) => WorkspaceInterceptor;
};

/** Throws for an agent id that could name another bot's machine. */
export function assertAgentId(agentId: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId))
    throw new InvalidAgentId({
      agentId,
      message: `Invalid agent id: ${agentId}`,
    });
}

const DAEMON_DIRECTORY: Partial<Record<NodeJS.Architecture, string>> = {
  arm64: "arm64",
  x64: "x64",
};

/** The host path of pi-env's Linux daemon for `arch`, the guest's architecture. */
export function daemonPath(arch: NodeJS.Architecture = process.arch) {
  const directory = DAEMON_DIRECTORY[arch];

  if (!directory) {
    const cause = new Error(`Unsupported guest architecture: ${arch}`);

    throw new WorkspaceConfigFailed({
      message: cause.message,
      cause,
    });
  }

  return path.join(
    path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-env"))),
    "..",
    "bin",
    `pi-env-linux-${directory}`,
    "pi-env",
  );
}

type Running = {
  machine: WorkspaceMachine;
  desktopReady: Promise<void>;
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

const relayRequest = z.array(z.string());

/**
 * Reports each call, so the workspace knows when it is idle. `info` and `session` count too: they connect, and a
 * machine that idle-stopped while its daemon starts fails the call.
 */
class TrackedConnection extends Connection {
  constructor(
    options: ConnectionOptions,
    private readonly activity: Activity,
  ) {
    super(options);
  }

  override request(...args: Parameters<Connection["request"]>) {
    return this.tracked(() => super.request(...args));
  }

  override info() {
    return this.tracked(() => super.info());
  }

  override session() {
    return this.tracked(() => super.session());
  }

  private async tracked<T>(call: () => Promise<T>) {
    this.activity.begin();

    try {
      return await call();
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
  // Viewers and an owner holding control: the machine stays up while any hold.
  private holds = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly owner: MachineWorkspaces,
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
      id: `${owner.kind}:${agentId}`,
      cwd: WORKSPACE_PATH,
    });
  }

  /** Start and stop never overlap, and concurrent callers share one start. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);

    return result;
  }

  /** The relay command once the machine runs and, unless `displayOnly`, its bot desktop's browser is up. */
  async ensureStarted(displayOnly = false) {
    const running = await this.exclusive(async () => {
      // A bot that gained or lost its bot desktop needs the other image.
      const image = this.owner.imageFor(this.agentId);

      if (
        this.running &&
        this.running.machine.image === image &&
        (await this.running.machine.isAlive())
      )
        return this.running;

      if (this.running) await this.teardown();

      this.running = await this.owner.boot(this.agentId, image);
      this.armIdleTimer();

      return this.running;
    });

    // Outside the queue: a viewer needs only the display and does not wait for a job's browser.
    if (displayOnly) return running.command;

    try {
      await running.desktopReady;
    } catch (error) {
      await this.exclusive(async () => {
        if (this.running === running) await this.teardown();
      });
      throw error;
    }

    return running.command;
  }

  sync() {
    return this.exclusive(async () => {
      await this.running?.machine.sync();
    });
  }

  /** Stops only an idle workspace unless forced. A restart keeps the connection, which reconnects on next use. */
  stop(force: boolean, keepConnection = false) {
    clearTimeout(this.idleTimer);

    return this.exclusive(async () => {
      // pi-env's Connection reconnects after losing its bridge but not after close(), so only the last stop closes it.
      if (force && !keepConnection) this.connection.close();

      if (!this.running || (!force && (this.inflight > 0 || this.holds > 0)))
        return;

      await this.teardown();
    });
  }

  /** Keeps the machine from its idle stop until released. */
  hold() {
    this.holds += 1;
    clearTimeout(this.idleTimer);

    let released = false;

    return () => {
      if (released) return;

      released = true;
      this.holds -= 1;
      this.armIdleTimer();
    };
  }

  /** A stream to Xvnc in the guest, through socat on an exec stream like the pi-env relay: no guest port. */
  async openDesktop(): Promise<DesktopStream> {
    const desktopImage = this.owner.desktopImageName();

    if (!desktopImage)
      throw new BotDesktopNotConfigured({
        agentId: this.agentId,
        message:
          "This bot has no bot desktop: no desktop image is configured (CRUMBLE_WORKSPACE_DESKTOP_IMAGE)",
      });

    const release = this.hold();

    try {
      await this.ensureStarted(true);

      const running = this.running;

      if (!running || running.machine.image !== desktopImage)
        throw new BotDesktopImageMissing({
          agentId: this.agentId,
          image: running?.machine.image ?? this.owner.imageFor(this.agentId),
          message:
            "This bot has no bot desktop: its workspace is running the plain image",
        });

      const stream = await running.machine
        .stream("socat", ["-", "TCP:127.0.0.1:5900"])
        .catch((error) => {
          throw desktopStreamFailure(this.agentId)(error);
        });

      // Writes to the guest are async; chaining keeps them in order.
      let writes = Promise.resolve();

      return {
        write: (data) => (writes = writes.then(() => stream.write(data))),
        output: stream.output,
        close: async () => {
          release();
          await stream.end().catch(() => undefined);
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  private armIdleTimer() {
    clearTimeout(this.idleTimer);

    if (!this.running || this.inflight > 0 || this.holds > 0) return;

    this.idleTimer = setTimeout(
      () =>
        void this.stop(false).catch((error) =>
          Effect.runPromise(
            Effect.logError("Workspace idle stop failed", this.agentId, error),
          ),
        ),
      this.idleTimeoutMs,
    );
    this.idleTimer.unref();
  }

  private async teardown() {
    const running = this.running;

    this.running = undefined;

    try {
      await running?.relay.close();
      await running?.machine.stop();
    } catch (error) {
      throw stopFailure(this.agentId)(error);
    }
  }
}

/**
 * Per-bot workspaces on machines from a backend: the machine starts on the first operation and stops after
 * `idleTimeoutMs` of inactivity, while viewers hold it awake. Which image it boots follows the bot's need for its
 * bot desktop; the backend keeps the files across stops and image changes.
 */
export class MachineWorkspaces implements WorkspaceService {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly idleTimeoutMs: number;
  private readonly desktopImage: string | undefined;
  private readonly wantsDesktop: (agentId: string) => boolean;
  private readonly caCertificate:
    | ((agentId: string) => Promise<string>)
    | undefined;
  private closed = false;

  constructor(
    private readonly machines: WorkspaceMachines,
    private readonly image: string,
    options: MachineWorkspacesOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.desktopImage = options.desktopImage;
    this.wantsDesktop = options.wantsDesktop ?? (() => false);
    this.caCertificate = options.caCertificate;
  }

  get kind() {
    return this.machines.kind;
  }

  /** The desktop image, if any; a machine booted from it has a bot desktop. */
  desktopImageName() {
    return this.desktopImage;
  }

  get desktop() {
    return this.desktopImage !== undefined;
  }

  /** The image the bot's machine boots now: the desktop image while the bot needs its bot desktop. */
  imageFor(agentId: string) {
    return this.desktopImage && this.wantsDesktop(agentId)
      ? this.desktopImage
      : this.image;
  }

  openDesktop(agentId: string) {
    return Effect.tryPromise({
      try: () => this.workspace(agentId).openDesktop(),
      catch: desktopStreamFailure(agentId),
    });
  }

  startDesktop(agentId: string) {
    return Effect.tryPromise({
      try: async () => {
        assertAgentId(agentId);

        if (!this.desktopImage)
          throw new BotDesktopNotConfigured({
            agentId,
            message:
              "This bot has no bot desktop: no desktop image is configured (CRUMBLE_WORKSPACE_DESKTOP_IMAGE)",
          });

        await this.workspace(agentId).ensureStarted(true);
      },
      catch: desktopStartFailure(agentId),
    });
  }

  keepAwake(agentId: string) {
    return this.workspace(agentId).hold();
  }

  env(agentId: string, shellEnv?: Record<string, string>) {
    const workspace = this.workspace(agentId);

    return shellEnv && Object.keys(shellEnv).length
      ? new RemoteExecutionEnv({
          connection: workspace.connection,
          id: workspace.env.id,
          cwd: WORKSPACE_PATH,
          shellEnv: { ...this.machines.proxyEnv, ...shellEnv },
        })
      : workspace.env;
  }

  restart(agentId: string): Effect.Effect<void, WorkspaceFailure> {
    return Effect.tryPromise({
      try: async () => {
        await this.workspaces.get(agentId)?.stop(true, true);
      },
      catch: stopFailure(agentId),
    });
  }

  sync(agentId: string): Effect.Effect<void, WorkspaceFailure> {
    return Effect.tryPromise({
      try: async () => {
        await this.workspaces.get(agentId)?.sync();
      },
      catch: syncFailure(agentId),
    });
  }

  get close(): Effect.Effect<void, WorkspaceFailure> {
    return Effect.suspend(() => {
      this.closed = true;

      return Effect.forEach(
        [...this.workspaces.values()],
        (workspace) =>
          Effect.tryPromise({
            try: () => workspace.stop(true),
            catch: stopFailure(workspace.agentId),
          }),
        { concurrency: "unbounded", discard: true },
      );
    });
  }

  /** Boots the bot's machine and a relay for its daemon; called by `Workspace`, serialized per bot. */
  async boot(agentId: string, image: string): Promise<Running> {
    if (this.closed)
      throw new WorkspacesClosed({
        message: "The workspace is shutting down",
      });

    let machine: WorkspaceMachine;

    try {
      machine = await this.machines.boot(agentId, image, {
        caCertificate: await this.caCertificate?.(agentId),
      });
    } catch (error) {
      throw isWorkspaceFailure(error) ? error : bootFailure(agentId)(error);
    }

    const desktopReady = machine.desktopReady().catch((error) => {
      throw isWorkspaceFailure(error)
        ? error
        : desktopStartFailure(agentId)(error);
    });

    // Awaited by later callers; a failure before then must not go unhandled.
    desktopReady.catch(() => undefined);

    try {
      const relay = await startRelay(machine);

      return {
        machine,
        desktopReady,
        relay,
        command: [process.execPath, BRIDGE_PATH, relay.socketPath],
      };
    } catch (error) {
      await machine.stop().catch(() => undefined);
      throw isWorkspaceFailure(error) ? error : bootFailure(agentId)(error);
    }
  }

  private workspace(agentId: string) {
    assertAgentId(agentId);

    let workspace = this.workspaces.get(agentId);

    if (!workspace) {
      workspace = new Workspace(this, agentId, this.idleTimeoutMs);
      this.workspaces.set(agentId, workspace);
    }

    return workspace;
  }
}

/**
 * A unix socket that runs the daemon in the guest per connection: only this process can run commands in the machine,
 * so the `Connection` command is a bridge process that talks to this relay.
 */
async function startRelay(machine: WorkspaceMachine): Promise<Relay> {
  const dir = await mkdtemp(path.join(tmpdir(), "crumble-workspace-"));
  const socketPath = path.join(dir, "relay.sock");
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    serveRelayConnection(machine, socket);
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
function serveRelayConnection(machine: WorkspaceMachine, socket: net.Socket) {
  let pending = Buffer.alloc(0);

  const onFirstData = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);

    const newline = pending.indexOf(10);

    if (newline < 0) return;

    socket.off("data", onFirstData);
    socket.pause();

    const args = daemonArgs(pending.subarray(0, newline).toString());

    if (!args) return void socket.destroy();

    pipeDaemon(machine, socket, args, pending.subarray(newline + 1)).catch(() =>
      socket.destroy(),
    );
  };

  socket.on("data", onFirstData);
}

async function pipeDaemon(
  machine: WorkspaceMachine,
  socket: net.Socket,
  args: string[],
  rest: Buffer,
) {
  const daemon = await machine.stream(GUEST_DAEMON, args);

  // Writes to the guest are async; chaining keeps them in order.
  let writes = Promise.resolve();

  const enqueue = (write: () => Promise<void>) => {
    writes = writes.then(write).catch(() => void socket.destroy());
  };

  if (rest.length) enqueue(() => daemon.write(rest));
  socket.on("data", (data: Buffer) => enqueue(() => daemon.write(data)));
  socket.on("end", () => enqueue(() => daemon.end()));
  socket.on("close", () => enqueue(() => daemon.end()));
  socket.resume();

  for await (const data of daemon.output) socket.write(data);

  socket.end();
}
