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
  bootStep,
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
  allowAllRequests,
  type WorkspaceNetworkPolicy,
} from "./workspace";
import {
  DesktopStartFailed,
  WorkspaceStopFailed,
  WorkspaceStreamFailed,
  WorkspaceSyncFailed,
  messageOf,
} from "./workspace-errors";
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
  boot(agentId: string, image: string, guest: GuestSetup = {}) {
    return Effect.gen({ self: this }, function* () {
      const name = this.name(agentId);

      yield* bootStep("Opening the workspace volume", () => ensureVolume(name));

      const decide = ({ host, port }: { host: string; port: number }) =>
        this.network({ agentId, host, port });

      const intercept = this.intercept?.(agentId);
      const daemon = this.daemon;
      const desktop = image === this.desktopImage;

      let sandbox: Sandbox | undefined;
      let proxy: WorkspaceProxy | undefined;

      return yield* Effect.gen(function* () {
        // A machine's network settings are fixed at creation, so a restarted one needs its proxy at the same port.
        const resumed = yield* Effect.promise(() => resume(name));

        sandbox = resumed;

        const record = resumed
          ? yield* Effect.promise(() => readMachineRecord(resumed))
          : undefined;

        if (resumed && record?.image === image)
          proxy = yield* Effect.promise(() =>
            startWorkspaceProxy({
              decide,
              intercept,
              port: record.proxyPort,
            }).catch(() => undefined),
          );

        let machine: Sandbox;

        if (resumed && proxy) machine = resumed;
        else {
          yield* Effect.promise(
            async () => await resumed?.stop().catch(() => undefined),
          );

          const created = yield* bootStep("Starting the workspace proxy", () =>
            startWorkspaceProxy({ decide, intercept }),
          );

          proxy = created;
          // replace() also takes over a machine that could not be resumed.
          machine = yield* bootStep("Creating the sandbox", () =>
            Sandbox.builder(name)
              .image(image)
              .cpus(CPUS)
              .memory(MEMORY_MIB)
              .volume(WORKSPACE_PATH, (mount) => mount.named(name))
              .proxy((outbound) => outbound.httpConnect(created.address))
              .replace()
              .create(),
          );
          sandbox = machine;

          const fresh = machine;

          const machineRecord: MachineRecord = {
            image,
            proxyPort: Number(created.address.split(":")[1]),
          };

          yield* bootStep("Recording the machine's image", async () => {
            await fresh.fs().write(MACHINE_FILE, JSON.stringify(machineRecord));
            await flush(fresh);
          });
        }

        const machineProxy = proxy;
        const booted = machine;

        yield* bootStep("Installing the pi-env daemon", async () => {
          await booted.fs().write(GUEST_DAEMON, await readFile(daemon));
          await run(booted, `chmod 755 ${GUEST_DAEMON}`);
        });

        if (guest.caCertificate) {
          const caCertificate = guest.caCertificate;

          yield* bootStep("Installing the credential authority", async () => {
            await booted.fs().write(GUEST_CA_PATH, caCertificate);
            await run(booted, "update-ca-certificates >/dev/null");
          });
        }

        if (desktop)
          yield* startDesktop(
            booted,
            `${DESKTOP_START} ${DESKTOP_DISPLAY_ONLY}`,
          );

        return new MicrosandboxMachine(booted, machineProxy, image, desktop);
      }).pipe(
        Effect.onError(() =>
          Effect.promise(async () => {
            await sandbox?.stop().catch(() => undefined);
            await proxy?.close();
          }),
        ),
      );
    });
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
  get desktopReady() {
    return this.desktop
      ? startDesktop(this.sandbox, DESKTOP_START)
      : Effect.void;
  }

  get isAlive() {
    return Effect.promise(() => this.alive());
  }

  stream(command: string, args: readonly string[]) {
    return Effect.tryPromise({
      try: () => this.open(command, args),
      catch: (cause) =>
        new WorkspaceStreamFailed({
          message: `${command} did not start: ${messageOf(cause)}`,
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
          message: `Syncing the workspace failed: ${messageOf(cause)}`,
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
          message: `Stopping the sandbox failed: ${messageOf(cause)}`,
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

/** Runs `desktop-start.sh` with its arguments; its output says why the bot desktop did not start. */
const startDesktop = (sandbox: Sandbox, command: string) =>
  Effect.tryPromise({
    try: () => run(sandbox, command),
    catch: (cause) =>
      new DesktopStartFailed({
        message: `The bot desktop did not start: ${messageOf(cause)}`,
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
