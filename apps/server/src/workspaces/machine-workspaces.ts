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
import { Deferred, Effect, Exit, Semaphore } from "effect";
import { z } from "zod";
import {
  DesktopNotConfigured,
  DesktopStartError,
  DesktopStreamError,
  InvalidAgentId,
  MachineBootError,
  PlainWorkspaceImage,
  WORKSPACE_PATH,
  WorkspaceOperationError,
  WorkspacesClosed,
  type DesktopOpenError,
  type DesktopStream,
  type WorkspaceError,
  type Workspaces,
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
  readonly isAlive: Effect.Effect<boolean, WorkspaceOperationError>;
  /** Succeeds once the bot desktop's browser is up; at once on an image without a bot desktop. */
  readonly desktopReady: Effect.Effect<void, DesktopStartError>;
  stream(
    command: string,
    args: readonly string[],
  ): Effect.Effect<MachineStream, DesktopStreamError>;
  /** Makes completed writes in the workspace durable. */
  readonly sync: Effect.Effect<void, WorkspaceOperationError>;
  /** Makes the workspace durable while the machine still runs, then stops it and frees what it held. */
  readonly stop: Effect.Effect<void, WorkspaceOperationError>;
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
  ): Effect.Effect<WorkspaceMachine, MachineBootError | DesktopStartError>;
}

export type MachineWorkspacesOptions = {
  idleTimeoutMs?: number;
  /** The image for bots with a bot desktop: the base image plus the desktop. */
  desktopImage?: string;
  /** Whether the bot needs its bot desktop; read at each boot. */
  wantsDesktop?: (agentId: string) => boolean;
  /** The bot's credential proxy authority, installed at every boot. */
  caCertificate?: (agentId: string) => Promise<string> | Effect.Effect<string>;
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

/** Validates an agent id in Effect. */
export const checkAgentId = (
  agentId: string,
): Effect.Effect<string, InvalidAgentId> =>
  /^[A-Za-z0-9_-]{1,64}$/.test(agentId)
    ? Effect.succeed(agentId)
    : Effect.fail(
        new InvalidAgentId({
          agentId,
          message: `Invalid agent id: ${agentId}`,
        }),
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
  desktopReady: Deferred.Deferred<void, DesktopStartError>;
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
      { command: () => Effect.runPromise(this.ensureStarted(false)) },
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
  private exclusive<A, E>(task: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return this.lock.withPermits(1)(task);
  }

  /** The relay command once the machine runs and, unless `displayOnly`, its bot desktop's browser is up. */
  ensureStarted(
    displayOnly = false,
  ): Effect.Effect<
    readonly string[],
    WorkspacesClosed | MachineBootError | DesktopStartError
  > {
    return Effect.gen({ self: this }, function* () {
      const running = yield* this.exclusive(
        Effect.gen({ self: this }, function* () {
          // A bot that gained or lost its bot desktop needs the other image.
          const image = this.owner.imageFor(this.agentId);

          if (
            this.running &&
            this.running.machine.image === image &&
            (yield* this.running.machine.isAlive.pipe(
              Effect.orElseSucceed(() => false),
            ))
          )
            return this.running;

          if (this.running) yield* Effect.ignore(this.teardown);

          this.running = yield* this.owner.boot(this.agentId, image);
          this.armIdleTimer();

          return this.running;
        }),
      );

      // Outside the queue: a viewer needs only the display and does not wait for a job's browser.
      if (displayOnly) return running.command;

      return yield* Deferred.await(running.desktopReady).pipe(
        Effect.tapError(() =>
          this.exclusive(
            Effect.gen({ self: this }, function* () {
              if (this.running === running) yield* Effect.ignore(this.teardown);
            }),
          ),
        ),
        Effect.as(running.command),
      );
    });
  }

  get sync(): Effect.Effect<void, WorkspaceOperationError> {
    return this.exclusive(
      Effect.gen({ self: this }, function* () {
        if (this.running) yield* this.running.machine.sync;
      }),
    );
  }

  /** Stops only an idle workspace unless forced. A restart keeps the connection, which reconnects on next use. */
  stop(
    force: boolean,
    keepConnection = false,
  ): Effect.Effect<void, WorkspaceOperationError> {
    clearTimeout(this.idleTimer);

    return this.exclusive(
      Effect.gen({ self: this }, function* () {
        // pi-env's Connection reconnects after losing its bridge but not after close(), so only the last stop closes it.
        if (force && !keepConnection) this.connection.close();

        if (!this.running || (!force && (this.inflight > 0 || this.holds > 0)))
          return;

        yield* this.teardown;
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
  openDesktop(): Effect.Effect<DesktopStream, DesktopOpenError> {
    return Effect.gen({ self: this }, function* () {
      const desktopImage = this.owner.desktopImageName();

      if (!desktopImage)
        return yield* new DesktopNotConfigured({
          message:
            "No desktop workspace image is configured (set CRUMBLE_WORKSPACE_DESKTOP_IMAGE)",
        });

      const release = this.hold();

      return yield* Effect.gen({ self: this }, function* () {
        const wanted = this.owner.imageFor(this.agentId);

        if (wanted !== desktopImage)
          return yield* new PlainWorkspaceImage({
            agentId: this.agentId,
            image: wanted,
            message: `This bot has no bot desktop (workspace image is ${wanted})`,
          });

        yield* this.ensureStarted(true);

        const running = this.running;

        if (!running || running.machine.image !== desktopImage)
          return yield* new PlainWorkspaceImage({
            agentId: this.agentId,
            image: running?.machine.image ?? wanted,
            message: `This bot has no bot desktop (workspace image is ${running?.machine.image ?? wanted})`,
          });

        const stream = yield* running.machine.stream("socat", [
          "-",
          "TCP:127.0.0.1:5900",
        ]);

        // Writes to the guest are async; chaining keeps them in order.
        let writes = Promise.resolve();

        return {
          write: (data: Uint8Array) =>
            (writes = writes.then(() => stream.write(data))),
          output: stream.output,
          close: async () => {
            release();
            await stream.end().catch(() => undefined);
          },
        };
      }).pipe(Effect.onError(() => Effect.sync(release)));
    });
  }

  private armIdleTimer() {
    clearTimeout(this.idleTimer);

    if (!this.running || this.inflight > 0 || this.holds > 0) return;

    this.idleTimer = setTimeout(
      () => void Effect.runPromise(Effect.ignore(this.stop(false))),
      this.idleTimeoutMs,
    );
    this.idleTimer.unref();
  }

  private get teardown(): Effect.Effect<void, WorkspaceOperationError> {
    return Effect.gen({ self: this }, function* () {
      const running = this.running;

      this.running = undefined;

      if (!running) return;

      yield* Effect.promise(() => running.relay.close());
      yield* running.machine.stop;
    });
  }
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
    | ((agentId: string) => Promise<string> | Effect.Effect<string>)
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

  openDesktop(agentId: string): Effect.Effect<DesktopStream, DesktopOpenError> {
    return Effect.gen({ self: this }, function* () {
      const workspace = yield* this.workspaceEffect(agentId);

      return yield* workspace.openDesktop();
    }).pipe(Effect.withSpan("MachineWorkspaces.openDesktop"));
  }

  startDesktop(agentId: string): Effect.Effect<void, DesktopOpenError> {
    return Effect.gen({ self: this }, function* () {
      if (!this.desktopImage)
        return yield* new DesktopNotConfigured({
          message:
            "No desktop workspace image is configured (set CRUMBLE_WORKSPACE_DESKTOP_IMAGE)",
        });

      const workspace = yield* this.workspaceEffect(agentId);
      const wanted = this.imageFor(agentId);

      if (wanted !== this.desktopImage)
        return yield* new PlainWorkspaceImage({
          agentId,
          image: wanted,
          message: `This bot has no bot desktop (workspace image is ${wanted})`,
        });

      yield* workspace.ensureStarted(true);
    }).pipe(Effect.withSpan("MachineWorkspaces.startDesktop"));
  }

  keepAwake(agentId: string): Effect.Effect<() => void, InvalidAgentId> {
    return Effect.gen({ self: this }, function* () {
      const workspace = yield* this.workspaceEffect(agentId);

      return workspace.hold();
    });
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

  restart(agentId: string): Effect.Effect<void, WorkspaceError> {
    return Effect.gen({ self: this }, function* () {
      yield* checkAgentId(agentId);
      const workspace = this.workspaces.get(agentId);

      if (workspace) yield* workspace.stop(true, true);
    }).pipe(Effect.withSpan("MachineWorkspaces.restart"));
  }

  sync(agentId: string): Effect.Effect<void, WorkspaceError> {
    return Effect.gen({ self: this }, function* () {
      yield* checkAgentId(agentId);
      const workspace = this.workspaces.get(agentId);

      if (workspace) yield* workspace.sync;
    }).pipe(Effect.withSpan("MachineWorkspaces.sync"));
  }

  get close(): Effect.Effect<void, WorkspaceError> {
    return Effect.gen({ self: this }, function* () {
      this.closed = true;

      yield* Effect.forEach(
        [...this.workspaces.values()],
        (workspace) => workspace.stop(true),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.withSpan("MachineWorkspaces.close"));
  }

  /** Boots the bot's machine and a relay for its daemon; called by `Workspace`, serialized per bot. */
  boot(
    agentId: string,
    image: string,
  ): Effect.Effect<
    Running,
    WorkspacesClosed | MachineBootError | DesktopStartError
  > {
    return Effect.gen({ self: this }, function* () {
      if (this.closed)
        return yield* new WorkspacesClosed({
          message: "Workspaces are closed",
        });

      const caCertificate = this.caCertificate
        ? yield* Effect.gen({ self: this }, function* () {
            const pending = this.caCertificate!(agentId);

            return Effect.isEffect(pending)
              ? yield* pending
              : yield* Effect.tryPromise({
                  try: () => pending,
                  catch: (cause) =>
                    new MachineBootError({
                      backend: this.kind,
                      agentId,
                      message: `Failed to load CA certificate: ${cause instanceof Error ? cause.message : String(cause)}`,
                      cause,
                    }),
                });
          })
        : undefined;

      const machine = yield* this.machines.boot(agentId, image, {
        caCertificate,
      });

      const desktopReady = yield* Deferred.make<void, DesktopStartError>();

      // Awaited by later callers; runs in the background while viewers connect to the display.
      void Effect.runFork(
        machine.desktopReady.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Deferred.succeed(desktopReady, undefined)
              : Deferred.failCause(desktopReady, exit.cause),
          ),
        ),
      );

      const relay = yield* Effect.tryPromise({
        try: () => startRelay(machine),
        catch: (cause) =>
          new MachineBootError({
            backend: this.kind,
            agentId,
            message: `Failed to start workspace relay: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      }).pipe(Effect.tapError(() => Effect.ignore(machine.stop)));

      return {
        machine,
        desktopReady,
        relay,
        command: [process.execPath, BRIDGE_PATH, relay.socketPath],
      };
    });
  }

  private workspaceEffect(
    agentId: string,
  ): Effect.Effect<Workspace, InvalidAgentId> {
    return Effect.map(checkAgentId(agentId), () => this.workspace(agentId));
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
  const daemon = await Effect.runPromise(
    machine
      .stream(GUEST_DAEMON, args)
      .pipe(
        Effect.mapError((error) => new Error(error.message, { cause: error })),
      ),
  );

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
