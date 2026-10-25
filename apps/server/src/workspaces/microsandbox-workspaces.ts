import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { Sandbox, Volume, VolumeNotFoundError } from "microsandbox";
import { z } from "zod";
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
  DesktopStartError,
  DesktopStreamError,
  GUEST_CA_PATH,
  MachineBootError,
  WORKSPACE_PATH,
  WorkspaceOperationError,
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
  boot(
    agentId: string,
    image: string,
    guest: GuestSetup = {},
  ): Effect.Effect<WorkspaceMachine, MachineBootError | DesktopStartError> {
    const bootStep = <A>(tryPromise: () => Promise<A>) =>
      Effect.tryPromise({
        try: tryPromise,
        catch: (cause) =>
          new MachineBootError({
            backend: this.kind,
            agentId,
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

    return Effect.gen({ self: this }, function* () {
      const name = this.name(agentId);

      yield* bootStep(() => ensureVolume(name));

      const decide = ({ host, port }: { host: string; port: number }) =>
        this.network({ agentId, host, port });

      const intercept = this.intercept?.(agentId);

      let sandbox: Sandbox | undefined;
      let proxy: WorkspaceProxy | undefined;

      const cleanup = Effect.promise(async () => {
        await sandbox?.stop().catch(() => undefined);
        await proxy?.close();
      });

      return yield* Effect.gen({ self: this }, function* () {
        // A machine's network settings are fixed at creation, so a restarted one needs its proxy at the same port.
        sandbox = yield* bootStep(() => resume(name));

        const record = sandbox
          ? yield* bootStep(() => readMachineRecord(sandbox!))
          : undefined;

        if (sandbox && record?.image === image)
          proxy = yield* bootStep(() =>
            startWorkspaceProxy({
              decide,
              intercept,
              port: record.proxyPort,
            }).catch(() => undefined),
          );

        if (!proxy) {
          yield* bootStep(async () => {
            await sandbox?.stop().catch(() => undefined);
            proxy = await startWorkspaceProxy({ decide, intercept });
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

            const createdRecord: MachineRecord = {
              image,
              proxyPort: Number(address.split(":")[1]),
            };

            await sandbox
              .fs()
              .write(MACHINE_FILE, JSON.stringify(createdRecord));
            await flush(sandbox);
          });
        }

        const machine = sandbox!;

        yield* bootStep(async () => {
          await machine.fs().write(GUEST_DAEMON, await readFile(this.daemon));
          await run(machine, `chmod 755 ${GUEST_DAEMON}`);

          if (guest.caCertificate) {
            await machine.fs().write(GUEST_CA_PATH, guest.caCertificate);
            await run(machine, "update-ca-certificates >/dev/null");
          }
        });

        const desktop = image === this.desktopImage;

        if (desktop)
          yield* Effect.tryPromise({
            try: () => run(machine, `${DESKTOP_START} ${DESKTOP_DISPLAY_ONLY}`),
            catch: (cause) =>
              new DesktopStartError({
                agentId,
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          });

        return new MicrosandboxMachine(machine, proxy!, image, desktop);
      }).pipe(Effect.onError(() => cleanup));
    }).pipe(Effect.withSpan("MicrosandboxMachines.boot"));
  }
}

class MicrosandboxMachine implements WorkspaceMachine {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly proxy: WorkspaceProxy,
    readonly image: string,
    private readonly desktop: boolean,
  ) {}

  /** The start script, run again: while the desktop is up it only waits for the browser. */
  get desktopReady(): Effect.Effect<void, DesktopStartError> {
    if (!this.desktop) return Effect.void;

    return Effect.tryPromise({
      try: () => run(this.sandbox, DESKTOP_START),
      catch: (cause) =>
        new DesktopStartError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  }

  get isAlive(): Effect.Effect<boolean, WorkspaceOperationError> {
    return Effect.promise(() =>
      this.sandbox.ping().then(
        () => true,
        () => false,
      ),
    );
  }

  stream(
    command: string,
    args: readonly string[],
  ): Effect.Effect<MachineStream, DesktopStreamError> {
    const sandbox = this.sandbox;

    return Effect.tryPromise({
      try: async () => {
        const exec = await sandbox.execStreamWith(command, (options) =>
          options.args([...args]).stdinPipe(),
        );

        const stdin = await exec.takeStdin();

        if (!stdin) throw new Error(`${command} has no stdin`);

        async function* output() {
          for await (const event of exec)
            if (event.kind === "stdout") yield new Uint8Array(event.data);
        }

        return {
          write: (data: Uint8Array) => stdin.write(data),
          end: () => stdin.close(),
          output: output(),
        };
      },
      catch: (cause) =>
        new DesktopStreamError({
          command,
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  }

  /** A killed machine loses what the guest had not synced. */
  get sync(): Effect.Effect<void, WorkspaceOperationError> {
    return Effect.tryPromise({
      try: () => flush(this.sandbox),
      catch: (cause) =>
        new WorkspaceOperationError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  }

  get stop(): Effect.Effect<void, WorkspaceOperationError> {
    return Effect.tryPromise({
      try: async () => {
        try {
          const alive = await this.sandbox.ping().then(
            () => true,
            () => false,
          );

          if (alive) await flush(this.sandbox);
        } finally {
          await this.sandbox.stop().catch(() => undefined);
          await this.proxy.close();
        }
      },
      catch: (cause) =>
        new WorkspaceOperationError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
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
