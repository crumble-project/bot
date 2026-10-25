import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Exit, Fiber, Schema, Semaphore } from "effect";
import {
  Connection,
  RemoteExecutionEnv,
  type ConnectionOptions,
} from "@earendil-works/pi-env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { z } from "zod";
import {
  WORKSPACE_PATH,
  WorkspaceClosed,
  WorkspaceDesktopDisabled,
  WorkspaceDesktopUnavailable,
  WorkspaceInvalidAgentId,
  WorkspaceRelayError,
  WorkspaceSetupError,
  workspacePromise,
  type WorkspaceError,
  type DesktopStream,
  type Workspaces,
} from "./workspace";
import type { WorkspaceInterceptor } from "./workspace-proxy";

const BRIDGE_PATH = path.join(import.meta.dir, "workspace-bridge.ts");

const logCleanup = (message: string) =>
  Effect.catchCause((cause: Cause.Cause<WorkspaceError>) =>
    Effect.logError(message, cause),
  );

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
  isAlive(): Effect.Effect<boolean, WorkspaceError>;
  /** Completes once the bot desktop's browser is up; at once on a plain image. */
  desktopReady(): Effect.Effect<void, WorkspaceError>;
  stream(
    command: string,
    args: readonly string[],
  ): Effect.Effect<MachineStream, WorkspaceError>;
  sync(): Effect.Effect<void, WorkspaceError>;
  stop(): Effect.Effect<void, WorkspaceError>;
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
  ): Effect.Effect<WorkspaceMachine, WorkspaceError>;
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

const AgentId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
const validAgentId = Schema.is(AgentId);

/** Synchronous boundary for backend naming helpers. */
export function assertAgentId(agentId: string) {
  if (!validAgentId(agentId)) throw new WorkspaceInvalidAgentId({ agentId });
}

const DAEMON_DIRECTORY: Partial<Record<NodeJS.Architecture, string>> = {
  arm64: "arm64",
  x64: "x64",
};

/** The host path of pi-env's Linux daemon for `arch`, the guest's architecture. */
export function daemonPath(arch: NodeJS.Architecture = process.arch) {
  const directory = DAEMON_DIRECTORY[arch];

  if (!directory)
    throw new Error(`Workspaces need an arm64 or x64 guest, not ${arch}`);

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
  desktopReady: Fiber.Fiber<void, WorkspaceError>;
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
  private readonly lock = Semaphore.makeUnsafe(1);

  constructor(
    private readonly owner: MachineWorkspaces,
    readonly agentId: string,
    private readonly idleTimeoutMs: number,
  ) {
    this.connection = new TrackedConnection(
      { command: () => workspacePromise(this.ensureStarted()) },
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
  private exclusive<A, E>(task: Effect.Effect<A, E>) {
    return Semaphore.withPermit(this.lock, Effect.uninterruptible(task));
  }

  /** The relay command once the machine runs and, unless `displayOnly`, its bot desktop's browser is up. */
  readonly ensureStarted = Effect.fn("Workspace.ensureStarted")(function* (
    this: Workspace,
    displayOnly = false,
  ) {
    const running = yield* this.exclusive(
      Effect.gen({ self: this }, function* () {
        yield* this.owner.checkOpen();
        const image = this.owner.imageFor(this.agentId);

        if (
          this.running &&
          this.running.machine.image === image &&
          (yield* this.running.machine.isAlive())
        )
          return this.running;

        if (this.running) yield* this.teardown();
        this.running = yield* this.owner.boot(this.agentId, image);
        this.armIdleTimer();

        return this.running;
      }),
    );

    // Viewers need the display, not the browser; waiting here must not hold the boot lock.
    if (!displayOnly) {
      yield* Fiber.join(running.desktopReady).pipe(
        Effect.onError(() =>
          this.exclusive(
            Effect.suspend(() =>
              this.running === running ? this.teardown() : Effect.void,
            ),
          ).pipe(logCleanup("Desktop readiness cleanup failed")),
        ),
      );
    }

    return running.command;
  });

  sync() {
    return this.exclusive(
      Effect.suspend(() => this.running?.machine.sync() ?? Effect.void),
    );
  }

  /** Stops only an idle workspace unless forced. A restart keeps the connection, which reconnects on next use. */
  stop(force: boolean, keepConnection = false) {
    return this.exclusive(
      Effect.suspend(() => {
        clearTimeout(this.idleTimer);

        // A restart keeps pi-env's reconnectable connection; only the final stop closes it.
        if (force && !keepConnection) this.connection.close();

        if (!this.running || (!force && (this.inflight > 0 || this.holds > 0)))
          return Effect.void;

        return this.teardown();
      }),
    );
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
  readonly openDesktop = Effect.fn("Workspace.openDesktop")(function* (
    this: Workspace,
  ): Effect.fn.Return<DesktopStream, WorkspaceError> {
    const release = this.hold();

    return yield* Effect.gen({ self: this }, function* () {
      yield* this.ensureStarted(true);

      return yield* this.exclusive(
        Effect.gen({ self: this }, function* () {
          const running = this.running;

          if (
            !running ||
            running.machine.image !== this.owner.desktopImageName()
          )
            return yield* new WorkspaceDesktopDisabled({
              agentId: this.agentId,
            });

          const stream = yield* running.machine.stream("socat", [
            "-",
            "TCP:127.0.0.1:5900",
          ]);

          let writes = Promise.resolve();

          return {
            write: (data: Uint8Array) =>
              (writes = writes.then(() => stream.write(data))),
            output: stream.output,
            close: async () => {
              release();
              await stream.end();
            },
          };
        }),
      );
    }).pipe(
      Effect.onError(() => Effect.sync(release)),
      Effect.uninterruptible,
    );
  });

  private armIdleTimer() {
    clearTimeout(this.idleTimer);

    if (!this.running || this.inflight > 0 || this.holds > 0) return;

    this.idleTimer = setTimeout(() => {
      Effect.runFork(
        this.stop(false).pipe(logCleanup("Workspace idle stop failed")),
      );
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private readonly teardown = Effect.fn("Workspace.teardown")(function* (
    this: Workspace,
  ) {
    const running = this.running;
    this.running = undefined;

    if (!running) return;
    yield* Fiber.interrupt(running.desktopReady);

    const relay = yield* Effect.tryPromise({
      try: () => running.relay.close(),
      catch: (cause) =>
        new WorkspaceRelayError({
          agentId: this.agentId,
          backend: this.owner.kind,
          operation: "close",
          cause,
        }),
    }).pipe(Effect.exit);

    const machine = yield* running.machine.stop().pipe(Effect.exit);

    if (Exit.isFailure(relay)) {
      if (Exit.isFailure(machine))
        yield* Effect.logError(
          "Workspace machine stop also failed",
          machine.cause,
        );

      return yield* relay;
    }

    return yield* machine;
  });
}

/**
 * Per-bot workspaces on machines from a backend: the machine starts on the first operation and stops after
 * `idleTimeoutMs` of inactivity, while viewers hold it awake. Which image it boots follows the bot's need for its
 * bot desktop; the backend keeps the files across stops and image changes.
 */
export class MachineWorkspaces implements Workspaces {
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

  readonly openDesktop = Effect.fn("Workspaces.openDesktop")(function* (
    this: MachineWorkspaces,
    agentId: string,
  ) {
    const workspace = yield* this.workspace(agentId);
    yield* this.checkDesktop(agentId);

    return yield* workspace.openDesktop();
  });

  readonly startDesktop = Effect.fn("Workspaces.startDesktop")(function* (
    this: MachineWorkspaces,
    agentId: string,
  ) {
    const workspace = yield* this.workspace(agentId);
    yield* this.checkDesktop(agentId);
    yield* workspace.ensureStarted(true);
  });

  readonly keepAwake = Effect.fn("Workspaces.keepAwake")(function* (
    this: MachineWorkspaces,
    agentId: string,
  ) {
    return (yield* this.workspace(agentId)).hold();
  });

  readonly env = Effect.fn("Workspaces.env")(function* (
    this: MachineWorkspaces,
    agentId: string,
    shellEnv?: Record<string, string>,
  ): Effect.fn.Return<ExecutionEnv, WorkspaceError> {
    const workspace = yield* this.workspace(agentId);

    return shellEnv && Object.keys(shellEnv).length
      ? new RemoteExecutionEnv({
          connection: workspace.connection,
          id: workspace.env.id,
          cwd: WORKSPACE_PATH,
          shellEnv: { ...this.machines.proxyEnv, ...shellEnv },
        })
      : workspace.env;
  });

  readonly restart = Effect.fn("Workspaces.restart")(function* (
    this: MachineWorkspaces,
    agentId: string,
  ) {
    yield* this.validate(agentId);
    yield* this.workspaces.get(agentId)?.stop(true, true) ?? Effect.void;
  });

  readonly sync = Effect.fn("Workspaces.sync")(function* (
    this: MachineWorkspaces,
    agentId: string,
  ) {
    yield* this.validate(agentId);
    yield* this.workspaces.get(agentId)?.sync() ?? Effect.void;
  });

  readonly close = Effect.fn("Workspaces.close")(function* (
    this: MachineWorkspaces,
  ) {
    this.closed = true;

    const exits = yield* Effect.forEach(
      this.workspaces.values(),
      (workspace) => workspace.stop(true).pipe(Effect.exit),
      { concurrency: "unbounded" },
    );

    for (const exit of exits)
      if (Exit.isFailure(exit))
        yield* Effect.logError("Workspace close failed", exit.cause);

    for (const exit of exits) if (Exit.isFailure(exit)) return yield* exit;
  }, Effect.uninterruptible);

  /** Boots the bot's machine and a relay for its daemon; called by `Workspace`, serialized per bot. */
  readonly boot = Effect.fn("Workspaces.boot")(function* (
    this: MachineWorkspaces,
    agentId: string,
    image: string,
  ): Effect.fn.Return<Running, WorkspaceError> {
    yield* this.validate(agentId);

    const caCertificate = yield* Effect.tryPromise({
      try: async () => this.caCertificate?.(agentId),
      catch: (cause) =>
        new WorkspaceSetupError({
          agentId,
          backend: this.kind,
          operation: "credential authority",
          cause,
        }),
    });

    const machine = yield* this.machines.boot(agentId, image, {
      caCertificate,
    });

    const relay = yield* Effect.tryPromise({
      try: () => startRelay(machine),
      catch: (cause) =>
        new WorkspaceRelayError({
          agentId,
          backend: this.kind,
          operation: "listen",
          cause,
        }),
    }).pipe(
      Effect.onError(() =>
        machine.stop().pipe(logCleanup("Workspace boot cleanup failed")),
      ),
    );

    const desktopReady = Effect.runFork(
      machine
        .desktopReady()
        .pipe(
          Effect.tapError((error) =>
            Effect.logError("Workspace desktop readiness failed", error),
          ),
        ),
    );

    return {
      machine,
      desktopReady,
      relay,
      command: [process.execPath, BRIDGE_PATH, relay.socketPath],
    };
  });

  checkOpen() {
    return Effect.suspend(() =>
      this.closed ? Effect.fail(new WorkspaceClosed({})) : Effect.void,
    );
  }

  private readonly validate = Effect.fnUntraced(function* (
    this: MachineWorkspaces,
    agentId: string,
  ) {
    if (!validAgentId(agentId))
      return yield* new WorkspaceInvalidAgentId({ agentId });
    yield* this.checkOpen();
  });

  private readonly checkDesktop = Effect.fnUntraced(function* (
    this: MachineWorkspaces,
    agentId: string,
  ) {
    if (!this.desktop)
      return yield* new WorkspaceDesktopUnavailable({ agentId });

    if (!this.wantsDesktop(agentId))
      return yield* new WorkspaceDesktopDisabled({ agentId });
  });

  private readonly workspace = Effect.fnUntraced(function* (
    this: MachineWorkspaces,
    agentId: string,
  ) {
    yield* this.validate(agentId);
    let workspace = this.workspaces.get(agentId);

    if (!workspace) {
      workspace = new Workspace(this, agentId, this.idleTimeoutMs);
      this.workspaces.set(agentId, workspace);
    }

    return workspace;
  });
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

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (cause) {
    server.close();
    await rm(dir, { recursive: true, force: true }).catch((cleanup) =>
      Effect.runPromise(
        Effect.logError("Workspace relay setup cleanup failed", cleanup),
      ),
    );
    throw cause;
  }

  return {
    socketPath,
    async close() {
      for (const socket of sockets) socket.destroy();

      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
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

    pipeDaemon(machine, socket, args, pending.subarray(newline + 1)).catch(
      (cause) => {
        socket.destroy();
        Effect.runFork(Effect.logError("Workspace daemon relay failed", cause));
      },
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
  const daemon = await workspacePromise(machine.stream(GUEST_DAEMON, args));

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
