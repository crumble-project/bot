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
import { Effect, Exit, Fiber, Semaphore, type Scope } from "effect";
import { z } from "zod";
import {
  WORKSPACE_PATH,
  type DesktopStream,
  type Workspaces,
} from "./workspace";
import {
  DesktopNotConfigured,
  DesktopNotEnabled,
  DesktopNotRunning,
  WorkspaceBootFailed,
  WorkspacesClosed,
  messageOf,
  type DesktopOpenError,
  type DesktopStartFailed,
  type WorkspaceStartError,
  type WorkspaceStopFailed,
  type WorkspaceStreamFailed,
  type WorkspaceSyncFailed,
  type WorkspaceUnreachable,
} from "./workspace-errors";
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
  readonly isAlive: Effect.Effect<boolean, WorkspaceUnreachable>;
  /** Succeeds once the bot desktop's browser is up; at once on an image without a bot desktop. */
  readonly desktopReady: Effect.Effect<void, DesktopStartFailed>;
  stream(
    command: string,
    args: readonly string[],
  ): Effect.Effect<MachineStream, WorkspaceStreamFailed>;
  /** Makes completed writes in the workspace durable. */
  readonly sync: Effect.Effect<void, WorkspaceSyncFailed>;
  /** Makes the workspace durable while the machine still runs, then stops it and frees what it held. */
  readonly stop: Effect.Effect<void, WorkspaceStopFailed>;
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
  ): Effect.Effect<WorkspaceMachine, WorkspaceBootFailed | DesktopStartFailed>;
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

/** What the server gives every workspace backend; each backend reads its images and secrets from the environment. */
export type WorkspaceBackendOptions = Omit<
  MachineWorkspacesOptions,
  "desktopImage"
> & {
  /** Where a backend may record its machines, so a restarted server finds them. */
  dataDir: string;
  /** Prefix of machine names, which may be global to the backend's account. */
  namePrefix: string;
};

/** Throws for an agent id that could name another bot's machine. */
export function assertAgentId(agentId: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId))
    throw new Error(`Invalid agent id: ${agentId}`);
}

/** One step of a boot through a backend's SDK; its failure names the step. */
export const bootStep = <A>(step: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new WorkspaceBootFailed({
        message: `${step} failed: ${messageOf(cause)}`,
        cause,
      }),
  });

/** Acquires a resource for a boot that releases it only if the boot fails: on success the booted machine owns it. */
export const untilBooted = <A, E>(
  acquire: Effect.Effect<A, E>,
  release: (resource: A) => Promise<void>,
): Effect.Effect<A, E, Scope.Scope> =>
  Effect.acquireRelease(acquire, (resource, exit) =>
    Exit.isFailure(exit)
      ? Effect.promise(() => release(resource))
      : Effect.void,
  );

/** Logs the failure of work nobody waits for, such as cleanup after another failure or an idle stop. */
export const logFailure =
  (label: string, agentId: string) =>
  <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logError(label, agentId, cause)),
    );

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
  // Started at boot; a job joins it, a viewer does not wait for it.
  desktopReady: Fiber.Fiber<void, DesktopStartFailed>;
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
    // pi-env runs this command for its connection: the Pi boundary, where a failed start rejects with its tagged error.
    this.connection = new TrackedConnection(
      { command: () => Effect.runPromise(this.ensureStarted()) },
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

  /** Start and stop never overlap, and concurrent callers share one start; a caller that leaves does not stop one halfway. */
  private exclusive<A, E>(task: Effect.Effect<A, E>) {
    return Semaphore.withPermit(this.lock, Effect.uninterruptible(task));
  }

  /** The running machine, booted on the image the bot needs now, and unless `displayOnly` with its browser up. */
  private readonly start = Effect.fn("Workspace.start")(function* (
    this: Workspace,
    displayOnly: boolean,
  ) {
    const running = yield* this.exclusive(this.boot());

    // Outside the lock: a viewer needs only the display and does not wait for a job's browser.
    if (displayOnly) return running;

    yield* Fiber.join(running.desktopReady).pipe(
      Effect.onError(() =>
        this.exclusive(
          Effect.suspend(() =>
            this.running === running ? this.teardown() : Effect.void,
          ),
        ).pipe(
          logFailure("Stopping a workspace whose desktop failed", this.agentId),
        ),
      ),
    );

    return running;
  });

  /** The running machine if it runs the image the bot needs now, otherwise a new one; called under the lock. */
  private readonly boot = Effect.fn("Workspace.boot")(function* (
    this: Workspace,
  ) {
    // A bot that gained or lost its bot desktop needs the other image.
    const image = this.owner.imageFor(this.agentId);

    if (
      this.running &&
      this.running.machine.image === image &&
      (yield* this.running.machine.isAlive)
    )
      return this.running;

    if (this.running) yield* this.teardown();

    const booted = yield* this.owner.boot(this.agentId, image);

    this.running = booted;
    this.armIdleTimer();

    return booted;
  });

  /** The relay command once the machine runs and, unless `displayOnly`, its bot desktop's browser is up. */
  ensureStarted(
    displayOnly = false,
  ): Effect.Effect<readonly string[], WorkspaceStartError> {
    return this.start(displayOnly).pipe(Effect.map(({ command }) => command));
  }

  sync() {
    return this.exclusive(
      Effect.suspend(() => this.running?.machine.sync ?? Effect.void),
    );
  }

  /** Stops only an idle workspace unless forced. A restart keeps the connection, which reconnects on next use. */
  stop(force: boolean, keepConnection = false) {
    return Effect.suspend(() => {
      clearTimeout(this.idleTimer);

      return this.exclusive(
        Effect.suspend(() => {
          // pi-env's Connection reconnects after losing its bridge but not after close(), so only the last stop closes it.
          if (force && !keepConnection) this.connection.close();

          if (
            !this.running ||
            (!force && (this.inflight > 0 || this.holds > 0))
          )
            return Effect.void;

          return this.teardown();
        }),
      );
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

  /** The desktop image, failing for a server without one or a bot that does not need its bot desktop. */
  private readonly desktopImage = Effect.fn("Workspace.desktopImage")(
    function* (this: Workspace) {
      const desktopImage = this.owner.desktopImageName();

      if (desktopImage === undefined)
        return yield* new DesktopNotConfigured({
          message: "This server has no bot desktop image",
        });

      if (this.owner.imageFor(this.agentId) !== desktopImage)
        return yield* new DesktopNotEnabled({
          message:
            "This bot has no bot desktop: it does not have the desktop tool",
        });

      return desktopImage;
    },
  );

  /** Boots the bot desktop's machine as far as its display, for a viewer about to connect. */
  startDesktop(): Effect.Effect<void, DesktopOpenError> {
    return this.desktopImage().pipe(Effect.andThen(this.start(true)));
  }

  /**
   * A stream to Xvnc in the guest, through socat on an exec stream like the pi-env relay: no guest port. A passive
   * stream neither boots nor holds the machine, so it ends when the machine stops.
   */
  readonly openDesktop = Effect.fn("Workspace.openDesktop")(function* (
    this: Workspace,
    passive: boolean,
  ): Effect.fn.Return<DesktopStream, DesktopOpenError> {
    const desktopImage = yield* this.desktopImage();

    if (passive)
      return yield* this.connectDesktop(
        desktopImage,
        this.runningDesktop(desktopImage),
        () => {},
      );

    const release = this.hold();

    return yield* this.connectDesktop(
      desktopImage,
      this.start(true),
      release,
    ).pipe(Effect.onError(() => Effect.sync(release)));
  });

  /** Whether the machine runs the bot desktop now. */
  desktopRunning() {
    const desktopImage = this.owner.desktopImageName();

    return (
      desktopImage !== undefined && this.running?.machine.image === desktopImage
    );
  }

  private runningDesktop(desktopImage: string) {
    return Effect.suspend(() => {
      const running = this.running;

      return running?.machine.image === desktopImage
        ? Effect.succeed(running)
        : Effect.fail(
            new DesktopNotRunning({
              message: "The bot desktop is not running",
            }),
          );
    });
  }

  private readonly connectDesktop = Effect.fn("Workspace.connectDesktop")(
    function* (
      this: Workspace,
      desktopImage: string,
      machine: Effect.Effect<Running, DesktopOpenError>,
      release: () => void,
    ) {
      const running = yield* machine;

      // The bot lost its bot desktop while the machine booted.
      if (running.machine.image !== desktopImage)
        return yield* new DesktopNotEnabled({
          message:
            "This bot has no bot desktop: it does not have the desktop tool",
        });

      const stream = yield* running.machine.stream("socat", [
        "-",
        "TCP:127.0.0.1:5900",
      ]);

      // Writes to the guest are async; chaining keeps them in order.
      let writes = Promise.resolve();

      return {
        write: (data) => (writes = writes.then(() => stream.write(data))),
        output: stream.output,
        close: async () => {
          release();
          await stream.end().catch(() => undefined);
        },
      } satisfies DesktopStream;
    },
  );

  private armIdleTimer() {
    clearTimeout(this.idleTimer);

    if (!this.running || this.inflight > 0 || this.holds > 0) return;

    this.idleTimer = setTimeout(
      () =>
        void Effect.runFork(
          this.stop(false).pipe(
            logFailure("Workspace idle stop failed", this.agentId),
          ),
        ),
      this.idleTimeoutMs,
    );
    this.idleTimer.unref();
  }

  private readonly teardown = Effect.fn("Workspace.teardown")(function* (
    this: Workspace,
  ) {
    const running = this.running;

    this.running = undefined;

    if (!running) return;

    yield* Effect.promise(() => running.relay.close());
    yield* running.machine.stop;
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

  openDesktop(agentId: string, options: { passive?: boolean } = {}) {
    return Effect.suspend(() =>
      this.workspace(agentId).openDesktop(options.passive === true),
    );
  }

  desktopRunning(agentId: string) {
    return this.workspaces.get(agentId)?.desktopRunning() ?? false;
  }

  startDesktop(agentId: string) {
    return Effect.suspend(() => this.workspace(agentId).startDesktop());
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

  restart(agentId: string) {
    return Effect.suspend(
      () => this.workspaces.get(agentId)?.stop(true, true) ?? Effect.void,
    );
  }

  sync(agentId: string) {
    return Effect.suspend(
      () => this.workspaces.get(agentId)?.sync() ?? Effect.void,
    );
  }

  /** Flushes and stops every running workspace; fails with the first stop that failed, after trying them all. */
  readonly close = Effect.fn("MachineWorkspaces.close")(function* (
    this: MachineWorkspaces,
  ): Effect.fn.Return<void, WorkspaceStopFailed> {
    this.closed = true;

    const exits = yield* Effect.forEach(
      [...this.workspaces.values()],
      (workspace) => Effect.exit(workspace.stop(true)),
      { concurrency: "unbounded" },
    );

    const failed = exits.find(Exit.isFailure);

    if (failed) return yield* Effect.failCause(failed.cause);
  });

  /** Boots the bot's machine and a relay for its daemon; called by `Workspace`, serialized per bot. */
  readonly boot = Effect.fn("MachineWorkspaces.boot")(function* (
    this: MachineWorkspaces,
    agentId: string,
    image: string,
  ): Effect.fn.Return<Running, WorkspaceStartError> {
    if (this.closed)
      return yield* new WorkspacesClosed({
        message: "The account's workspaces are closed",
      });

    const certificate = this.caCertificate;

    const caCertificate = certificate
      ? yield* bootStep("Reading the bot's credential authority", () =>
          certificate(agentId),
        )
      : undefined;

    const machine = yield* this.machines.boot(agentId, image, {
      caCertificate,
    });

    const desktopReady = yield* Effect.forkDetach(machine.desktopReady);

    const relay = yield* bootStep("Starting the workspace relay", () =>
      startRelay(machine),
    ).pipe(
      Effect.onError(() =>
        machine.stop.pipe(
          logFailure("Stopping a machine without its relay", agentId),
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

/** The workspaces `make` returns, stopped when the scope closes; a failed stop is a defect of closing. */
export const acquireWorkspaces = (
  make: () => MachineWorkspaces | undefined,
): Effect.Effect<MachineWorkspaces | undefined, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(make), (workspaces) =>
    workspaces ? Effect.orDie(workspaces.close()) : Effect.void,
  );

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
  const daemon = await Effect.runPromise(machine.stream(GUEST_DAEMON, args));

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
