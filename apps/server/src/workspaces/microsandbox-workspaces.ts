import { errorText } from "../shared/errors";
import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import {
  Rule,
  Sandbox,
  SandboxNotFoundError,
  Volume,
  VolumeNotFoundError,
  type NetworkPolicy,
  type SandboxHandle,
} from "microsandbox";
import { z } from "zod";
import {
  DESKTOP_START,
  GUEST_DAEMON,
  WORKSPACE_PATH,
} from "../../workspace-image/guest";
import {
  MachineWorkspaces,
  NO_GUEST,
  bootStep,
  daemonPath,
  machineName,
  prepareGuest,
  untilBooted,
  type GuestFile,
  type GuestOps,
  type GuestSetup,
  type MachineStream,
  type MachineWorkspacesOptions,
  type WorkspaceBackendOptions,
  type WorkspaceMachine,
  type WorkspaceSize,
  type WorkspaceMachines,
} from "./machine-workspaces";
import {
  DesktopStartFailed,
  WorkspaceRemoveFailed,
  WorkspaceStopFailed,
  WorkspaceStreamFailed,
  WorkspaceSyncFailed,
} from "./workspace-errors";
import {
  startWorkspaceProxy,
  type WorkspaceInterceptor,
  type WorkspaceProxy,
} from "./workspace-proxy";

const DISK_MIB = 8192;

// The proxy carries only TCP; UDP would leave the machine past it. DNS goes to the sandbox's resolver.
// Bump TCP_THROUGH_PROXY_VERSION on a change: settings are fixed at creation, so older machines are created anew.
const TCP_THROUGH_PROXY_VERSION = 1;

const TCP_THROUGH_PROXY: NetworkPolicy = {
  defaultEgress: "allow",
  defaultIngress: "allow",
  rules: [
    Rule.allowDns(),
    { ...Rule.denyEgress({ kind: "any" }), protocols: ["udp"] },
  ],
};

export type MicrosandboxWorkspacesOptions = MachineWorkspacesOptions &
  Pick<WorkspaceBackendOptions, "size" | "namePrefix">;

export function microsandboxWorkspacesFromEnv(
  env: Record<string, string | undefined>,
  options: MicrosandboxWorkspacesOptions,
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
 * `/workspace`. The volume survives machine stops and image changes. Outbound TCP goes through a per-workspace proxy.
 */
export class MicrosandboxWorkspaces extends MachineWorkspaces {
  private readonly microsandbox: MicrosandboxMachines;

  constructor(image: string, options: MicrosandboxWorkspacesOptions) {
    const machines = new MicrosandboxMachines(options);

    super(machines, image, options);
    this.microsandbox = machines;
  }

  name(agentId: string) {
    return this.microsandbox.name(agentId);
  }
}

class MicrosandboxMachines implements WorkspaceMachines {
  readonly kind = "microsandbox";
  private readonly namePrefix: string;
  private readonly intercept:
    | ((agentId: string) => WorkspaceInterceptor)
    | undefined;
  private readonly daemon = daemonPath();
  private readonly size: () => WorkspaceSize;

  constructor(options: MicrosandboxWorkspacesOptions) {
    this.size = options.size;
    this.intercept = options.intercept;
    this.namePrefix = options.namePrefix;
  }

  name(agentId: string) {
    return machineName(this.namePrefix, agentId);
  }

  /**
   * It restarts the bot's existing machine, so programs installed outside `/workspace` survive, and creates a new one
   * when the image changed, the machine does not start, or its proxy port is taken.
   */
  readonly boot = Effect.fn("MicrosandboxMachines.boot")(function* (
    this: MicrosandboxMachines,
    agentId: string,
    image: string,
    desktop: boolean,
    guest: GuestSetup = NO_GUEST,
  ) {
    const name = this.name(agentId);

    yield* bootStep("Opening the workspace volume", () => ensureVolume(name));

    const intercept = this.intercept?.(agentId);
    const { sandbox, proxy } = yield* this.machine(name, image, intercept);

    yield* prepareGuest(agentId, this.ops(sandbox), guest, desktop);

    return new MicrosandboxMachine(sandbox, proxy, image, desktop);
  }, Effect.scoped);

  remove(agentId: string) {
    const name = this.name(agentId);

    return Effect.tryPromise({
      try: async () => {
        await removeSandbox(name);
        await removeVolume(name);
      },
      catch: (cause) =>
        new WorkspaceRemoveFailed({
          message: `Removing the workspace failed: ${errorText(cause)}`,
          cause,
        }),
    });
  }

  private ops(sandbox: Sandbox): GuestOps {
    return {
      writeStep: "Installing the pi-env daemon",
      files: async () => [
        {
          path: GUEST_DAEMON,
          content: await readFile(this.daemon),
          mode: 0o755,
        },
      ],
      write: (files) => writeFiles(sandbox, files),
      run: (command) => run(sandbox, command),
      startDesktop: (...args) => startDesktop(sandbox, args),
      concurrency: 1,
    };
  }

  private readonly machine = Effect.fn("MicrosandboxMachines.machine")(
    function* (
      this: MicrosandboxMachines,
      name: string,
      image: string,
      intercept: WorkspaceInterceptor | undefined,
    ) {
      const resumed = yield* untilBooted(
        Effect.promise(() => resume(name)),
        stopSandbox,
      );

      const resumedProxy = resumed
        ? yield* this.resumedProxy(resumed, image, intercept)
        : undefined;

      if (resumed && resumedProxy)
        return { sandbox: resumed, proxy: resumedProxy };

      return yield* this.create(name, image, resumed, intercept);
    },
  );

  private readonly resumedProxy = Effect.fn(
    "MicrosandboxMachines.resumedProxy",
  )(function* (
    this: MicrosandboxMachines,
    sandbox: Sandbox,
    image: string,
    intercept: WorkspaceInterceptor | undefined,
  ) {
    const record = yield* Effect.promise(() => readMachineRecord(sandbox));

    const size = this.size();

    if (
      record?.image !== image ||
      record.network !== TCP_THROUGH_PROXY_VERSION ||
      record.cpus !== size.cpus ||
      record.memoryMib !== size.memoryMib
    )
      return undefined;

    // A machine's network settings are fixed at creation, so a restarted one needs its proxy at the same port.
    return yield* untilBooted(
      Effect.promise(() =>
        startWorkspaceProxy({ intercept, port: record.proxyPort }).catch(
          () => undefined,
        ),
      ),
      closeProxy,
    );
  });

  private readonly create = Effect.fn("MicrosandboxMachines.create")(function* (
    this: MicrosandboxMachines,
    name: string,
    image: string,
    resumed: Sandbox | undefined,
    intercept: WorkspaceInterceptor | undefined,
  ) {
    if (resumed) yield* Effect.promise(() => stopSandbox(resumed));
    const size = this.size();

    const proxy = yield* untilBooted(
      bootStep("Starting the workspace proxy", () =>
        startWorkspaceProxy({ intercept }),
      ),
      closeProxy,
    );

    // replace() also takes over a machine that could not be resumed.
    const sandbox = yield* untilBooted(
      bootStep("Creating the sandbox", () =>
        Sandbox.builder(name)
          .image(image)
          .cpus(size.cpus)
          .memory(size.memoryMib)
          .volume(WORKSPACE_PATH, (mount) => mount.named(name))
          .proxy((outbound) => outbound.httpConnect(proxy.address))
          .network((network) => network.policy(TCP_THROUGH_PROXY))
          .replace()
          .create(),
      ),
      stopSandbox,
    );

    const machineRecord: MachineRecord = {
      image,
      proxyPort: Number(proxy.address.split(":")[1]),
      network: TCP_THROUGH_PROXY_VERSION,
      ...size,
    };

    yield* bootStep("Recording the machine's image", async () => {
      await sandbox.fs().write(MACHINE_FILE, JSON.stringify(machineRecord));
      await flush(sandbox);
    });

    return { sandbox, proxy };
  });
}

class MicrosandboxMachine implements WorkspaceMachine {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly proxy: WorkspaceProxy,
    readonly image: string,
    private readonly desktop: boolean,
  ) {}

  get desktopReady() {
    return this.desktop ? startDesktop(this.sandbox, []) : Effect.void;
  }

  get isAlive() {
    return Effect.promise(() => this.alive());
  }

  stream(command: string, args: readonly string[]) {
    return Effect.tryPromise({
      try: () => this.open(command, args),
      catch: (cause) =>
        new WorkspaceStreamFailed({
          message: `${command} did not start: ${errorText(cause)}`,
          cause,
        }),
    });
  }

  /** A killed machine loses what the guest had not synced. */
  get sync() {
    return Effect.tryPromise({
      try: () => flush(this.sandbox),
      catch: (cause) =>
        new WorkspaceSyncFailed({
          message: `Syncing the workspace failed: ${errorText(cause)}`,
          cause,
        }),
    });
  }

  get stop() {
    return Effect.tryPromise({
      try: async () => {
        try {
          if (await this.alive()) await flush(this.sandbox);
        } finally {
          await this.sandbox.stop().catch(() => undefined);
          await this.proxy.close();
        }
      },
      catch: (cause) =>
        new WorkspaceStopFailed({
          message: `Stopping the sandbox failed: ${errorText(cause)}`,
          cause,
        }),
    });
  }

  private alive() {
    return this.sandbox.ping().then(
      () => true,
      () => false,
    );
  }

  private async open(
    command: string,
    args: readonly string[],
  ): Promise<MachineStream> {
    const exec = await this.sandbox.execStreamWith(command, (options) =>
      options.args([...args]).stdinPipe(),
    );

    const stdin = await exec.takeStdin();

    if (!stdin) throw new Error(`${command} has no stdin`);

    async function* output() {
      for await (const event of exec)
        if (event.kind === "stdout") yield new Uint8Array(event.data);
    }

    return {
      write: (data) => stdin.write(data),
      end: () => stdin.close(),
      output: output(),
    };
  }
}

const stopSandbox = async (sandbox: Sandbox | undefined) => {
  await sandbox?.stop().catch(() => undefined);
};

const closeProxy = async (proxy: WorkspaceProxy | undefined) => {
  await proxy?.close();
};

const startDesktop = (sandbox: Sandbox, args: readonly string[]) =>
  Effect.tryPromise({
    try: () => run(sandbox, [DESKTOP_START, ...args].join(" ")),
    catch: (cause) =>
      new DesktopStartFailed({
        message: `The bot desktop did not start: ${errorText(cause)}`,
        cause,
      }),
  });

/** The bot's workspace volume, created on first use. Disk volumes are ext4 with a journal. */
async function ensureVolume(name: string) {
  try {
    await Volume.get(name);
  } catch (error) {
    if (!(error instanceof VolumeNotFoundError)) throw error;

    await Volume.builder(name).disk().size(DISK_MIB).create();
  }
}

const MACHINE_FILE = "/etc/crumble-workspace.json";
const STOP_TIMEOUT_MS = 10_000;

const machineRecord = z.object({
  image: z.string(),
  proxyPort: z.number().int(),
  network: z.number().int(),
  cpus: z.number().int(),
  memoryMib: z.number().int(),
});

type MachineRecord = z.infer<typeof machineRecord>;

const stopHandle = async (handle: SandboxHandle) => {
  if (handle.status !== "stopped" && handle.status !== "created")
    await handle.stopWithTimeout(STOP_TIMEOUT_MS).catch(() => handle.kill());
};

async function removeSandbox(name: string) {
  try {
    await stopHandle(await Sandbox.get(name));
    await Sandbox.remove(name);
  } catch (error) {
    if (!(error instanceof SandboxNotFoundError)) throw error;
  }
}

async function removeVolume(name: string) {
  try {
    await Volume.remove(name);
  } catch (error) {
    if (!(error instanceof VolumeNotFoundError)) throw error;
  }
}

/**
 * Starts the bot's existing machine, first stopping it if a server that died left it running. Undefined when there is
 * none or it does not start: the caller then creates a new one.
 */
async function resume(name: string): Promise<Sandbox | undefined> {
  try {
    await stopHandle(await Sandbox.get(name));

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

async function writeFiles(sandbox: Sandbox, files: readonly GuestFile[]) {
  for (const { path, content, mode } of files) {
    await sandbox.fs().write(path, content);

    if (mode !== undefined)
      await run(sandbox, `chmod ${mode.toString(8)} ${path}`);
  }
}

async function run(sandbox: Sandbox, command: string) {
  const result = await sandbox.exec("/bin/sh", ["-c", command]);

  if (!result.success)
    throw new Error(`${command} failed: ${result.stderr() || result.stdout()}`);
}

const flush = (sandbox: Sandbox) => run(sandbox, "sync");
