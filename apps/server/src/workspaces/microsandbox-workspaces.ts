import { readFile } from "node:fs/promises";
import { Sandbox, Volume, VolumeNotFoundError } from "microsandbox";
import { z } from "zod";
import { Effect, Exit } from "effect";
import {
  DESKTOP_DISPLAY_ONLY,
  DESKTOP_START,
  GUEST_DAEMON,
  MachineWorkspaces,
  assertAgentId,
  daemonPath,
  type GuestSetup,
  type MachineStream,
  type MachineWorkspacesOptions,
  type WorkspaceMachine,
  type WorkspaceMachines,
} from "./machine-workspaces";
import {
  GUEST_CA_PATH,
  WORKSPACE_PATH,
  WorkspaceBootError,
  WorkspaceDesktopStartError,
  WorkspaceSetupError,
  WorkspaceStreamError,
  WorkspaceSyncError,
  WorkspaceStopError,
  workspaceOperation,
  workspacePromise,
  type WorkspaceError,
  allowAllRequests,
  type WorkspaceNetworkPolicy,
} from "./workspace";
import {
  startWorkspaceProxy,
  type WorkspaceInterceptor,
  type WorkspaceProxy,
} from "./workspace-proxy";

const DISK_MIB = 8192;
const MEMORY_MIB = 2048;
const CPUS = 2;

export type MicrosandboxWorkspacesOptions = MachineWorkspacesOptions & {
  /** Decides each outbound connection; defaults to allowing all. */
  network?: WorkspaceNetworkPolicy;
  /** Prefix of sandbox and volume names, which are global to the Microsandbox home. */
  namePrefix?: string;
};

/**
 * The workspaces when `CRUMBLE_WORKSPACE_IMAGE` (an OCI image reference) is set, otherwise undefined: without an image
 * there is no machine to run, so callers leave coding out rather than fail on first use. `CRUMBLE_WORKSPACE_DESKTOP_IMAGE`
 * adds the image for bots with a bot desktop.
 */
export function microsandboxWorkspacesFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: MicrosandboxWorkspacesOptions = {},
) {
  const image = env["CRUMBLE_WORKSPACE_IMAGE"];
  const desktopImage = env["CRUMBLE_WORKSPACE_DESKTOP_IMAGE"];

  return image
    ? new MicrosandboxWorkspaces(image, {
        ...options,
        ...(desktopImage && { desktopImage }),
      })
    : undefined;
}

/**
 * Microsandbox-backed workspaces: one microVM per bot, with the bot's files on a named, journaled disk volume at
 * `/workspace`. The volume survives machine stops and image changes. Outbound TCP goes through a per-workspace proxy
 * that asks the network policy.
 */
export class MicrosandboxWorkspaces extends MachineWorkspaces {
  private readonly microsandbox: MicrosandboxMachines;

  constructor(image: string, options: MicrosandboxWorkspacesOptions = {}) {
    const machines = new MicrosandboxMachines(options);

    super(machines, image, options);
    this.microsandbox = machines;
  }

  /** The bot's sandbox and volume name. */
  name(agentId: string) {
    return this.microsandbox.name(agentId);
  }
}

class MicrosandboxMachines implements WorkspaceMachines {
  readonly kind = "microsandbox";
  private readonly network: WorkspaceNetworkPolicy;
  private readonly namePrefix: string;
  private readonly desktopImage: string | undefined;
  private readonly intercept:
    | ((agentId: string) => WorkspaceInterceptor)
    | undefined;
  private readonly daemon = daemonPath();

  constructor(options: MicrosandboxWorkspacesOptions) {
    this.network = options.network ?? allowAllRequests;
    this.intercept = options.intercept;
    this.namePrefix = options.namePrefix ?? "crumble";
    this.desktopImage = options.desktopImage;
  }

  name(agentId: string) {
    assertAgentId(agentId);

    return `${this.namePrefix}-${agentId}`;
  }

  /**
   * It restarts the bot's existing machine, so programs installed outside `/workspace` survive, and creates a new one
   * when the image changed, the machine does not start, or its proxy port is taken.
   */
  readonly boot = Effect.fn("MicrosandboxMachines.boot")(
    (agentId: string, image: string, guest: GuestSetup = {}) =>
      workspaceOperation(
        () => this.bootMachine(agentId, image, guest),
        (cause) =>
          new WorkspaceBootError({
            agentId,
            backend: this.kind,
            operation: "boot",
            cause,
          }),
      ),
  );

  private async bootMachine(
    agentId: string,
    image: string,
    guest: GuestSetup,
  ): Promise<WorkspaceMachine> {
    const name = this.name(agentId);

    const setup = <A>(operation: string, run: () => Promise<A>) =>
      workspacePromise(
        workspaceOperation(
          run,
          (cause) =>
            new WorkspaceSetupError({
              agentId,
              backend: this.kind,
              operation,
              cause,
            }),
        ),
      );

    await setup("volume", () => ensureVolume(name));

    const decide = ({ host, port }: { host: string; port: number }) =>
      this.network({ agentId, host, port });

    const intercept = this.intercept?.(agentId);

    let sandbox: Sandbox | undefined;
    let proxy: WorkspaceProxy | undefined;

    try {
      // A machine's network settings are fixed at creation, so a restarted one needs its proxy at the same port.
      sandbox = await resume(name);
      const record = sandbox && (await readMachineRecord(sandbox));

      if (sandbox && record?.image === image)
        proxy = await startWorkspaceProxy({
          decide,
          intercept,
          port: record.proxyPort,
        }).catch(() => undefined);

      if (!proxy) {
        await sandbox?.stop().catch(() => undefined);
        proxy = await setup("proxy", () =>
          startWorkspaceProxy({ decide, intercept }),
        );
        const address = proxy.address;

        // replace() also takes over a machine that could not be resumed.
        sandbox = await Sandbox.builder(name)
          .image(image)
          .cpus(CPUS)
          .memory(MEMORY_MIB)
          .volume(WORKSPACE_PATH, (mount) => mount.named(name))
          .proxy((outbound) => outbound.httpConnect(address))
          .replace()
          .create();

        const record: MachineRecord = {
          image,
          proxyPort: Number(address.split(":")[1]),
        };

        await sandbox.fs().write(MACHINE_FILE, JSON.stringify(record));
        await flush(sandbox);
      }

      if (!sandbox)
        throw new WorkspaceBootError({
          agentId,
          backend: this.kind,
          operation: "create",
          cause: new Error("Sandbox creation returned no machine"),
        });
      const machine = sandbox;

      await setup("guest installation", async () => {
        await machine.fs().write(GUEST_DAEMON, await readFile(this.daemon));
        await run(machine, `chmod 755 ${GUEST_DAEMON}`);

        if (guest.caCertificate) {
          await machine.fs().write(GUEST_CA_PATH, guest.caCertificate);
          await run(machine, "update-ca-certificates >/dev/null");
        }
      });

      const desktop = image === this.desktopImage;

      if (desktop)
        await workspacePromise(
          workspaceOperation(
            () => run(machine, `${DESKTOP_START} ${DESKTOP_DISPLAY_ONLY}`),
            (cause) =>
              new WorkspaceDesktopStartError({
                agentId,
                backend: this.kind,
                operation: "display",
                cause,
              }),
          ),
        );

      return new MicrosandboxMachine(machine, proxy, image, desktop, agentId);
    } catch (error) {
      for (const cleanup of [() => sandbox?.stop(), () => proxy?.close()])
        await Effect.runPromise(
          Effect.tryPromise({
            try: async () => cleanup(),
            catch: (cause) => cause,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Microsandbox boot cleanup failed", cause),
            ),
          ),
        );
      throw error;
    }
  }
}

class MicrosandboxMachine implements WorkspaceMachine {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly proxy: WorkspaceProxy,
    readonly image: string,
    private readonly desktop: boolean,
    private readonly agentId: string,
  ) {}

  private failure(cause: unknown, operation: string) {
    return { agentId: this.agentId, backend: "microsandbox", operation, cause };
  }

  /** The start script, run again: while the desktop is up it only waits for the browser. */
  readonly desktopReady = Effect.fn("MicrosandboxMachine.desktopReady")(() =>
    workspaceOperation(
      async () => {
        if (this.desktop) await run(this.sandbox, DESKTOP_START);
      },
      (cause) => new WorkspaceDesktopStartError(this.failure(cause, "browser")),
    ),
  );

  isAlive() {
    return Effect.promise(() =>
      this.sandbox.ping().then(
        () => true,
        () => false,
      ),
    );
  }

  readonly stream = Effect.fn("MicrosandboxMachine.stream")(
    (command: string, args: readonly string[]) =>
      workspaceOperation(
        () => this.openStream(command, args),
        (cause) => new WorkspaceStreamError(this.failure(cause, command)),
      ),
  );

  private async openStream(
    command: string,
    args: readonly string[],
  ): Promise<MachineStream> {
    const exec = await this.sandbox.execStreamWith(command, (options) =>
      options.args([...args]).stdinPipe(),
    );

    const stdin = await exec.takeStdin();

    if (!stdin) throw new Error(`${command} has no stdin`);

    const failure = (cause: unknown) =>
      cause instanceof WorkspaceStreamError
        ? cause
        : new WorkspaceStreamError(this.failure(cause, command));

    async function* output() {
      let stderr = "";

      try {
        for await (const event of exec) {
          if (event.kind === "stdout") yield new Uint8Array(event.data);

          if (event.kind === "stderr")
            stderr = (stderr + Buffer.from(event.data).toString("utf8")).slice(
              -16_384,
            );

          if (event.kind === "exited" && event.code !== 0)
            throw failure({ event, stderr });
        }
      } catch (cause) {
        throw failure(cause);
      }
    }

    return {
      write: (data) =>
        workspacePromise(workspaceOperation(() => stdin.write(data), failure)),
      end: () =>
        workspacePromise(workspaceOperation(() => stdin.close(), failure)),
      output: output(),
    };
  }

  /** A killed machine loses what the guest had not synced. */
  readonly sync = Effect.fn("MicrosandboxMachine.sync")(() =>
    workspaceOperation(
      () => flush(this.sandbox),
      (cause) => new WorkspaceSyncError(this.failure(cause, "sync")),
    ),
  );

  readonly stop = Effect.fn("MicrosandboxMachine.stop")(function* (
    this: MicrosandboxMachine,
  ): Effect.fn.Return<void, WorkspaceError> {
    const sync = yield* Effect.gen({ self: this }, function* () {
      if (yield* this.isAlive()) yield* this.sync();
    }).pipe(Effect.exit);

    const stopped = yield* workspaceOperation(
      () => this.sandbox.stop(),
      (cause) => new WorkspaceStopError(this.failure(cause, "stop")),
    ).pipe(Effect.exit);

    const proxy = yield* workspaceOperation(
      () => this.proxy.close(),
      (cause) => new WorkspaceStopError(this.failure(cause, "proxy close")),
    ).pipe(Effect.exit);

    for (const exit of [sync, stopped, proxy])
      if (Exit.isFailure(exit))
        yield* Effect.logError("Microsandbox stop failed", exit.cause);
    yield* sync;
    yield* stopped;
    yield* proxy;
  }, Effect.uninterruptible);
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

/** Where a machine records what it was created from, on its own root disk. */
const MACHINE_FILE = "/etc/crumble-workspace.json";
const STOP_TIMEOUT_MS = 10_000;

const machineRecord = z.object({
  image: z.string(),
  proxyPort: z.number().int(),
});

type MachineRecord = z.infer<typeof machineRecord>;

/**
 * Starts the bot's existing machine, first stopping it if a server that died left it running. Undefined when there is
 * none or it does not start: the caller then creates a new one.
 */
async function resume(name: string): Promise<Sandbox | undefined> {
  try {
    const handle = await Sandbox.get(name);

    if (handle.status !== "stopped" && handle.status !== "created")
      await handle.stopWithTimeout(STOP_TIMEOUT_MS).catch(() => handle.kill());

    return await (await Sandbox.get(name)).start();
  } catch {
    return undefined;
  }
}

async function readMachineRecord(
  sandbox: Sandbox,
): Promise<MachineRecord | undefined> {
  try {
    const text = Buffer.from(await sandbox.fs().read(MACHINE_FILE)).toString(
      "utf8",
    );

    return machineRecord.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

async function run(sandbox: Sandbox, command: string) {
  const result = await sandbox.exec("/bin/sh", ["-c", command]);

  if (!result.success)
    throw new Error(`${command} failed: ${result.stderr() || result.stdout()}`);
}

const flush = (sandbox: Sandbox) => run(sandbox, "sync");
