import { createHash } from "node:crypto";
import net from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Sandbox,
  SandboxNotFoundError,
  type SandboxResources,
  type SandboxTemplate,
} from "railway";
import { Effect } from "effect";
import { z } from "zod";
import {
  DESKTOP_DISPLAY_ONLY,
  DESKTOP_START,
  GUEST_DAEMON,
  MachineWorkspaces,
  assertAgentId,
  bootStep,
  daemonPath,
  logFailure,
  untilBooted,
  type GuestSetup,
  type MachineStream,
  type MachineWorkspacesOptions,
  type WorkspaceMachine,
  type WorkspaceMachines,
} from "./machine-workspaces";
import { GUEST_CA_PATH, WORKSPACE_PATH } from "./workspace";
import {
  DesktopStartFailed,
  WorkspaceStopFailed,
  WorkspaceStreamFailed,
  WorkspaceUnreachable,
  messageOf,
} from "./workspace-errors";
import {
  startWorkspaceProxy,
  type WorkspaceInterceptor,
  type WorkspaceProxy,
} from "./workspace-proxy";
import {
  GUEST_PROXY_PORT,
  TUNNEL_SCRIPT,
  serveTunnel,
} from "./workspace-tunnel";

const STREAM_SCRIPT = path.join(import.meta.dir, "railway-stream.py");
const GUEST_STREAM = "/usr/local/lib/crumble/railway-stream.py";
const GUEST_PYTHON = "/usr/bin/python3";
const GUEST_TUNNEL = "/usr/local/lib/crumble/workspace-tunnel.py";

// A tunnel that ended while its machine runs is restarted after this long.
const TUNNEL_RESTART_MS = 1_000;
const GUEST_PROXY = `http://127.0.0.1:${GUEST_PROXY_PORT}`;
const ARCHIVE = "/tmp/crumble-workspace.tgz";
const DESKTOP_START_TIMEOUT_SEC = 120;

const DESKTOP_SCRIPTS = path.join(
  import.meta.dir,
  "../..",
  "workspace-image",
  "desktop",
);

// cua-driver's telemetry is on by default; the Microsandbox image sets the same in its environment.
const GUEST_ENV = { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", DO_NOT_TRACK: "1" };

const DEFAULT_RESOURCES: SandboxResources = { cpu: 2, memoryGB: 2 };

/** How long a workspace stays unchanged before a sync becomes a checkpoint. */
export const DEFAULT_CHECKPOINT_DELAY_MS = 30_000;

// Railway destroys a sandbox after this much idle time. The heartbeat keeps a running workspace alive, so it only
// bites a sandbox whose server died, and bounds how long a restarted server can still reconnect to it.
const RAILWAY_IDLE_TIMEOUT_MINUTES = 30;

// Also how soon a sandbox Railway destroyed is noticed: its exec streams do not end by themselves.
const HEARTBEAT_MS = 10_000;

/** The base workspace image, close to `workspace-image/Dockerfile`; Railway's Ubuntu already has node and git. */
const BASE_RECIPE = {
  packages: [
    "bash",
    "build-essential",
    "ca-certificates",
    "curl",
    "git",
    "make",
    "openssh-client",
    "python3",
    "python3-venv",
    "ripgrep",
  ],
  steps: [
    "curl -LsSf https://astral.sh/uv/0.13.1/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh",
    `mkdir -p ${WORKSPACE_PATH}`,
  ],
};

type Recipe = typeof BASE_RECIPE;

const CUA_DRIVER_VERSION = "0.38.0";
const PLAYWRIGHT_VERSION = "1.64.1";

// The Chromium project's own build closest after the Stable 156 branch point; Playwright now ships Chrome for Testing.
const CHROMIUM_REVISION = "1706547";

const CHROMIUM_SHA256 =
  "4388c45a42d73f45141d22d08518393b52a2398933521a6ce67482e59284a69c";

const CUA_DRIVER_SHA256 =
  "31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd";

/**
 * The base image plus the bot desktop, as in the Dockerfile's desktop stage. Ubuntu ships Chromium only as a snap, which
 * a sandbox cannot run, so the browser is a pinned Chromium snapshot build.
 */
const DESKTOP_RECIPE: Recipe = {
  packages: [
    ...BASE_RECIPE.packages,
    "tigervnc-standalone-server",
    "openbox",
    "tint2",
    "xdotool",
    "imagemagick",
    "fonts-dejavu-core",
    "fonts-noto-color-emoji",
    "socat",
    "procps",
    "dbus-x11",
    "at-spi2-core",
    "x11-utils",
    "zenity",
    "unzip",
    "libnss3-tools",
  ],
  steps: [
    ...BASE_RECIPE.steps,
    // Playwright knows the libraries Chromium needs on Ubuntu; it installs nothing else here.
    `bash -lc 'npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium'`,
    `curl -fsSLo /tmp/chromium.zip https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/${CHROMIUM_REVISION}/chrome-linux.zip`,
    `echo "${CHROMIUM_SHA256}  /tmp/chromium.zip" | sha256sum -c -`,
    "unzip -q /tmp/chromium.zip -d /opt/crumble && rm /tmp/chromium.zip",
    "ln -sf /opt/crumble/chrome-linux/chrome /usr/local/bin/chromium",
    `curl -fsSLo /tmp/cua-driver.tgz https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/cua-driver-rs-${CUA_DRIVER_VERSION}-linux-x86_64-binary.tar.gz`,
    `echo "${CUA_DRIVER_SHA256}  /tmp/cua-driver.tgz" | sha256sum -c -`,
    "tar -xzf /tmp/cua-driver.tgz -C /usr/local/bin cua-driver && rm /tmp/cua-driver.tgz",
    "CUA_DRIVER_RS_TELEMETRY_ENABLED=0 cua-driver telemetry disable",
    // Every window maximized and undecorated: the job sees content, not window chrome.
    `mkdir -p /opt/crumble && sed 's|<applications>|<applications><application class="*"><decor>no</decor><maximized>yes</maximized></application>|' /etc/xdg/openbox/rc.xml > /opt/crumble/openbox-rc.xml`,
  ],
};

/** Names an image by its recipe, so a changed recipe is a new image that bots move to. */
const imageName = (kind: string, recipe: Recipe) =>
  `railway-${kind}-${createHash("sha256").update(JSON.stringify(recipe)).digest("hex").slice(0, 12)}`;

export type RailwayWorkspacesOptions = Omit<
  MachineWorkspacesOptions,
  "desktopImage"
> & {
  /** Where each bot's sandbox id and image are recorded, so a restarted server finds its machines. */
  dataDir: string;
  /** Prefix of checkpoint names, which are global to the Railway environment. */
  namePrefix?: string;
  /** Region of new sandboxes; one that already has a checkpoint stays where it is. */
  region?: string;
  resources?: SandboxResources;
  checkpointDelayMs?: number;
  /** Whether bots can get a bot desktop; on by default. Its template takes minutes to build on first use. */
  desktop?: boolean;
};

/**
 * The workspaces when `CRUMBLE_WORKSPACE_BACKEND` is `railway`, otherwise undefined. The Railway SDK reads its
 * credentials itself: `RAILWAY_TOKEN` or `RAILWAY_API_TOKEN`, and `RAILWAY_ENVIRONMENT_ID`.
 */
export function railwayWorkspacesFromEnv(
  env: Record<string, string | undefined>,
  options: RailwayWorkspacesOptions,
) {
  if (env["CRUMBLE_WORKSPACE_BACKEND"] !== "railway") return undefined;

  const region = env["CRUMBLE_RAILWAY_REGION"];

  return new RailwayWorkspaces({ ...options, ...(region && { region }) });
}

/**
 * Railway-backed workspaces: one Railway sandbox per bot. Railway has no volumes, so a bot's files outlive its machine
 * as a named checkpoint of the whole disk: taken after `checkpointDelayMs` without a sync, and before every stop. A
 * server that dies leaves the sandbox running; the next server reconnects to it. Railway has no egress hook, so no
 * network policy applies; sandboxes are isolated from the environment's private network. A bot gaining or losing its
 * bot desktop moves to the other image with its `/workspace`.
 */
export class RailwayWorkspaces extends MachineWorkspaces {
  constructor(options: RailwayWorkspacesOptions) {
    const machines = new RailwayMachines(options);

    super(machines, machines.baseImage, {
      ...options,
      ...(machines.desktopImage && { desktopImage: machines.desktopImage }),
    });
  }
}

const machineRecord = z.object({
  /** The image of the bot's disk, running or checkpointed. */
  image: z.string(),
  /** The sandbox last booted for the bot; it may be gone. */
  sandboxId: z.string().optional(),
});

type MachineRecord = z.infer<typeof machineRecord>;

export class RailwayMachines implements WorkspaceMachines {
  readonly kind = "railway";
  // Railway has no egress hook: jobs reach the workspace proxy only through the tunnel, by these variables.
  readonly proxyEnv = {
    HTTPS_PROXY: GUEST_PROXY,
    https_proxy: GUEST_PROXY,
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  };
  readonly baseImage = imageName("base", BASE_RECIPE);
  readonly desktopImage: string | undefined;
  private readonly recipes = new Map<string, Recipe>();
  private readonly templates = new Map<string, Promise<SandboxTemplate>>();
  private readonly records: string;
  private readonly namePrefix: string;
  private readonly region: string | undefined;
  private readonly resources: SandboxResources;
  private readonly checkpointDelayMs: number;
  private readonly intercept:
    | ((agentId: string) => WorkspaceInterceptor)
    | undefined;
  // Railway runs x86_64 sandboxes whatever the host is.
  private readonly daemon = daemonPath("x64");

  constructor(options: RailwayWorkspacesOptions) {
    this.records = path.join(options.dataDir, "workspaces", "railway");
    this.namePrefix = options.namePrefix ?? "crumble";
    this.region = options.region;
    this.resources = options.resources ?? DEFAULT_RESOURCES;
    this.checkpointDelayMs =
      options.checkpointDelayMs ?? DEFAULT_CHECKPOINT_DELAY_MS;
    this.intercept = options.intercept;
    this.recipes.set(this.baseImage, BASE_RECIPE);

    if (options.desktop !== false) {
      this.desktopImage = imageName("desktop", DESKTOP_RECIPE);
      this.recipes.set(this.desktopImage, DESKTOP_RECIPE);
    }
  }

  /** The bot's checkpoint name. */
  name(agentId: string) {
    assertAgentId(agentId);

    return `${this.namePrefix}-${agentId}`;
  }

  /**
   * Reconnects to the sandbox a previous server left running, boots the bot's checkpoint, or creates a new sandbox
   * from the image. A checkpoint of another image has its `/workspace` copied into a new sandbox.
   */
  readonly boot = Effect.fn("RailwayMachines.boot")(function* (
    this: RailwayMachines,
    agentId: string,
    image: string,
    guest: GuestSetup = {},
  ) {
    if (!this.recipes.has(image))
      return yield* Effect.die(
        new Error(`Railway workspaces have no image ${image}`),
      );

    const name = this.name(agentId);
    const record = yield* Effect.promise(() => this.readRecord(agentId));
    const machine = yield* this.sandbox(agentId, name, image, record);
    const desktop = image === this.desktopImage;

    yield* this.prepareGuest(machine, desktop, guest);

    const intercept = this.intercept;

    // Without a credential proxy there is nothing to tunnel to: jobs connect directly.
    const proxy = intercept
      ? yield* bootStep("Starting the workspace proxy", () =>
          startWorkspaceProxy({
            decide: () => true,
            intercept: intercept(agentId),
          }),
        )
      : undefined;

    return new RailwayMachine(
      machine,
      agentId,
      name,
      image,
      desktop,
      this.checkpointDelayMs,
      proxy,
    );
  }, Effect.scoped);

  /** The sandbox to run in: the one still running for the bot, or a new one from its checkpoint. */
  private readonly sandbox = Effect.fn("RailwayMachines.sandbox")(function* (
    this: RailwayMachines,
    agentId: string,
    name: string,
    image: string,
    record: MachineRecord | undefined,
  ) {
    const sandboxId = record?.sandboxId;

    const running = sandboxId
      ? yield* bootStep("Reconnecting to the running sandbox", () =>
          connectRunning(sandboxId),
        )
      : undefined;

    const reconnected = record?.image === image ? running : undefined;

    // Keep the files it has written since its last checkpoint.
    if (running && !reconnected)
      yield* bootStep("Checkpointing the sandbox's other image", async () => {
        await checkpoint(running, name);
        await running.destroy();
      });

    // A new sandbox's files are all in the checkpoint; a reconnected one may hold writes the checkpoint lacks.
    return (
      reconnected ??
      (yield* untilBooted(
        bootStep("Creating the sandbox", () =>
          this.create(agentId, name, image, record),
        ),
        (sandbox) => sandbox.destroy().catch(() => undefined),
      ))
    );
  });

  /** Writes the guest's files and, on a desktop image, starts its bot desktop. */
  private readonly prepareGuest = Effect.fn("RailwayMachines.prepareGuest")(
    function* (
      this: RailwayMachines,
      machine: Sandbox,
      desktop: boolean,
      guest: GuestSetup,
    ) {
      // Each write is a request to Railway; in parallel they cost one round trip.
      yield* bootStep("Writing the guest files", async () => {
        await Promise.all([
          machine.files.write(GUEST_DAEMON, await readFile(this.daemon), {
            mode: 0o755,
          }),
          machine.files.write(GUEST_STREAM, await readFile(STREAM_SCRIPT)),
          machine.files.write(GUEST_TUNNEL, await readFile(TUNNEL_SCRIPT)),
          guest.caCertificate &&
            machine.files.write(GUEST_CA_PATH, guest.caCertificate),
          desktop && writeDesktopScripts(machine),
        ]);
      });

      if (guest.caCertificate)
        yield* bootStep("Installing the credential authority", () =>
          run(machine, "update-ca-certificates >/dev/null"),
        );

      if (desktop) yield* startDesktop(machine, DESKTOP_DISPLAY_ONLY);
    },
  );

  private async create(
    agentId: string,
    name: string,
    image: string,
    record: MachineRecord | undefined,
  ) {
    const options = {
      resources: this.resources,
      idleTimeoutMinutes: RAILWAY_IDLE_TIMEOUT_MINUTES,
      env: GUEST_ENV,
    };

    const saved = record !== undefined && (await hasCheckpoint(name));

    if (saved && record.image === image) {
      const sandbox = await Sandbox.create(name, options);

      await this.writeRecord(agentId, { image, sandboxId: sandbox.id });

      return sandbox;
    }

    // Only template sandboxes take a region: checkpoints boot where their data lives and reject another one.
    const sandbox = await Sandbox.create(await this.buildTemplate(image), {
      ...options,
      ...(this.region && { region: this.region }),
    });

    try {
      if (saved) {
        await copyWorkspace(name, sandbox, options);
        // The checkpoint must hold the new image before the record says so.
        await checkpoint(sandbox, name);
      }

      await this.writeRecord(agentId, { image, sandboxId: sandbox.id });
    } catch (error) {
      await sandbox.destroy().catch(() => undefined);
      throw error;
    }

    return sandbox;
  }

  /** Railway caches a template by its content, so later builds return at once. */
  private buildTemplate(image: string) {
    let template = this.templates.get(image);

    if (!template) {
      const recipe = this.recipes.get(image)!;

      template = Sandbox.template()
        .withPackages(...recipe.packages)
        .run(recipe.steps.join(" && "))
        .workdir(WORKSPACE_PATH)
        .build(this.region ? { region: this.region } : {});
      this.templates.set(image, template);
      template.catch(() => this.templates.delete(image));
    }

    return template;
  }

  private recordPath(agentId: string) {
    return path.join(this.records, `${agentId}.json`);
  }

  private async readRecord(agentId: string) {
    try {
      return machineRecord.safeParse(
        JSON.parse(await readFile(this.recordPath(agentId), "utf8")),
      ).data;
    } catch {
      return undefined;
    }
  }

  private async writeRecord(agentId: string, record: MachineRecord) {
    const file = this.recordPath(agentId);

    await mkdir(this.records, { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
}

class RailwayMachine implements WorkspaceMachine {
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  private checkpointing: Promise<void> = Promise.resolve();
  private readonly streams = new Set<ByteQueue>();

  private stopped = false;
  private tunnel: ReturnType<typeof serveTunnel> | undefined;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly agentId: string,
    private readonly name: string,
    readonly image: string,
    private readonly desktop: boolean,
    private readonly checkpointDelayMs: number,
    private readonly proxy?: WorkspaceProxy,
  ) {
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref();

    if (proxy) void this.openTunnel(proxy);
  }

  /** Carries the guest's proxy port to the workspace proxy for as long as the machine runs. */
  private async openTunnel(proxy: WorkspaceProxy) {
    if (this.stopped) return;

    const [host, port] = proxy.address.split(":");

    try {
      const tunnel = serveTunnel(
        this.open(GUEST_PYTHON, [GUEST_TUNNEL, String(GUEST_PROXY_PORT)]),
        () => net.connect(Number(port), host),
      );

      this.tunnel = tunnel;
      await tunnel.done;
    } catch {
      // Retried below, like a tunnel that ended.
    }

    if (this.stopped) return;
    setTimeout(() => void this.openTunnel(proxy), TUNNEL_RESTART_MS).unref();
  }

  /** Ends the streams of a sandbox Railway destroyed, so pi-env reconnects to a new one instead of waiting. */
  private async beat() {
    const alive = await this.sandbox.heartbeat().then(
      (sandbox) => sandbox.status === "RUNNING",
      // A sandbox of unknown state keeps its streams until the next beat.
      () => this.alive().catch(() => true),
    );

    if (alive) return;

    clearInterval(this.heartbeat);

    for (const stream of this.streams)
      stream.fail(new Error("Railway destroyed the sandbox"));
  }

  /** The start script, run again: while the desktop is up it only waits for the browser. */
  get desktopReady() {
    return this.desktop ? startDesktop(this.sandbox) : Effect.void;
  }

  get isAlive() {
    return Effect.tryPromise({
      try: () => this.alive(),
      catch: (cause) =>
        new WorkspaceUnreachable({
          message: `Railway could not report on the sandbox: ${messageOf(cause)}`,
          cause,
        }),
    });
  }

  stream(command: string, args: readonly string[]) {
    return Effect.try({
      try: () => this.open(command, args),
      catch: (cause) =>
        new WorkspaceStreamFailed({
          message: `${command} did not start: ${messageOf(cause)}`,
          cause,
        }),
    });
  }

  /** Rejects when Railway cannot tell, so a failed request never counts as a gone sandbox. */
  private alive() {
    return this.sandbox.refresh().then(
      (sandbox) => sandbox.status === "RUNNING",
      (error) => {
        if (error instanceof SandboxNotFoundError) return false;

        throw error;
      },
    );
  }

  private open(command: string, args: readonly string[]): MachineStream {
    const output = new ByteQueue();
    let pending = "";

    this.streams.add(output);

    const exec = this.sandbox.exec(
      [GUEST_PYTHON, GUEST_STREAM, command, ...args].map(quote).join(" "),
      {
        stdin: true,
        ephemeral: true,
        captureOutput: false,
        onStdout: (text) => {
          pending += text;

          const lines = pending.split("\n");

          pending = lines.pop() ?? "";

          for (const line of lines) output.push(Buffer.from(line, "base64"));
        },
      },
    );

    exec
      .finally(() => this.streams.delete(output))
      .then(
        () => output.end(),
        (error) =>
          output.fail(
            error instanceof Error ? error : new Error(String(error)),
          ),
      );

    return {
      write: (data) => exec.stdin.write(data),
      end: () => exec.stdin.end(),
      output,
    };
  }

  /**
   * Schedules a checkpoint instead of waiting for one: a checkpoint takes seconds, and a server crash loses nothing
   * while the sandbox runs on and the next server reconnects.
   */
  get sync() {
    return Effect.sync(() => {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = setTimeout(
        () =>
          void Effect.runFork(
            Effect.promise(() => this.checkpoint()).pipe(
              logFailure("Railway checkpoint failed", this.agentId),
            ),
          ),
        this.checkpointDelayMs,
      );
      this.checkpointTimer.unref();
    });
  }

  /**
   * Destroys the sandbox only after a checkpoint succeeded or Railway confirmed it gone; otherwise it keeps running,
   * for the next boot to reconnect to or Railway's idle timeout to end.
   */
  get stop() {
    return Effect.tryPromise({
      try: async () => {
        this.stopped = true;
        clearTimeout(this.checkpointTimer);
        clearInterval(this.heartbeat);
        await this.tunnel?.close();
        await this.proxy?.close();

        if (await this.alive()) await this.checkpoint();

        await this.sandbox.destroy().catch(() => undefined);
      },
      catch: (cause) =>
        new WorkspaceStopFailed({
          message: `Stopping the sandbox failed: ${messageOf(cause)}`,
          cause,
        }),
    });
  }

  /** One checkpoint at a time; a request during one takes another after it, so it covers every earlier write. */
  private checkpoint() {
    const next = this.checkpointing
      .catch(() => undefined)
      .then(() => checkpoint(this.sandbox, this.name));

    this.checkpointing = next;

    return next;
  }
}

/** Uploads the desktop scripts, which change with the server rather than the image, and starts the bot desktop. */
function writeDesktopScripts(sandbox: Sandbox) {
  return Promise.all(
    ["desktop-start.sh", "browser.sh"].map(async (script) =>
      sandbox.files.write(
        `/opt/crumble/${script}`,
        await readFile(path.join(DESKTOP_SCRIPTS, script)),
        { mode: 0o755 },
      ),
    ),
  );
}

/** Runs `desktop-start.sh`; its stderr says why the bot desktop did not start. */
const startDesktop = Effect.fn("startDesktop")(function* (
  sandbox: Sandbox,
  ...args: string[]
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      sandbox.exec([DESKTOP_START, ...args].join(" "), {
        timeoutSec: DESKTOP_START_TIMEOUT_SEC,
      }),
    catch: (cause) =>
      new DesktopStartFailed({
        message: `The bot desktop did not start: ${messageOf(cause)}`,
        cause,
      }),
  });

  if (result.exitCode !== 0)
    return yield* new DesktopStartFailed({
      message: `The bot desktop did not start: ${result.stderr}`,
      cause: result.stderr,
    });
});

/** A checkpoint snapshots the disk, not the guest's page cache, so recent writes need a `sync` first. */
async function checkpoint(sandbox: Sandbox, name: string) {
  await run(sandbox, "sync");
  await sandbox.checkpoint(name);
}

/** The running sandbox with this id, or undefined when Railway has destroyed it; other failures throw. */
async function connectRunning(id: string) {
  try {
    const sandbox = await Sandbox.connect(id);

    return sandbox.status === "RUNNING" ? sandbox : undefined;
  } catch (error) {
    if (error instanceof SandboxNotFoundError) return undefined;

    throw error;
  }
}

async function hasCheckpoint(name: string) {
  return (await Sandbox.checkpoints()).some(
    (checkpoint) => checkpoint.key === name,
  );
}

/** Copies `/workspace` from checkpoint `name` into `target` through Railway's binary file transfer. */
async function copyWorkspace(
  name: string,
  target: Sandbox,
  options: { resources: SandboxResources; idleTimeoutMinutes: number },
) {
  const source = await Sandbox.create(name, options);

  try {
    await run(source, `tar -C / -czf ${ARCHIVE} ${WORKSPACE_PATH.slice(1)}`);
    await target.files.write(
      ARCHIVE,
      await source.files.read(ARCHIVE, { format: "stream" }),
    );
    await run(
      target,
      `rm -rf ${WORKSPACE_PATH} && tar -C / -xzf ${ARCHIVE} && rm ${ARCHIVE}`,
    );
  } finally {
    await source.destroy().catch(() => undefined);
  }
}

async function run(sandbox: Sandbox, command: string) {
  const result = await sandbox.exec(command);

  if (result.exitCode !== 0)
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
}

const quote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

/** Bytes pushed by a callback, read as an async iterable. */
class ByteQueue implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private done = false;
  private error: Error | undefined;
  private wake: (() => void) | undefined;

  push(chunk: Uint8Array) {
    this.chunks.push(chunk);
    this.wake?.();
  }

  end() {
    this.done = true;
    this.wake?.();
  }

  fail(error: Error) {
    this.error = error;
    this.end();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const chunk = this.chunks.shift();

      if (chunk) {
        yield chunk;
        continue;
      }

      if (this.error) throw this.error;

      if (this.done) return;

      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}
