import { errorText } from "../../shared/errors";
import { shellQuote } from "../../shared/shell";
import { createHash } from "node:crypto";
import net from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Sandbox, SandboxNotFoundError } from "railway";
import type { SandboxResources, SandboxTemplate } from "railway";
import { Effect } from "effect";
import { z } from "zod";
import {
  BASE_ENV,
  BASE_PACKAGES,
  BUN_VERSION,
  CUA_DRIVER,
  DESKTOP_ENV,
  DESKTOP_PACKAGES,
  DESKTOP_SOURCES,
  DESKTOP_START,
  GH,
  GIT_TEMPLATE_DIR,
  GIT_TEMPLATE_SOURCES,
  GUEST_DAEMON,
  GUEST_FILES,
  GUEST_HELPERS,
  UV_VERSION,
  WORKSPACE_PATH,
  envWords,
} from "../../../workspace-image/guest";
import {
  MachineWorkspaces,
  NO_GUEST,
  bootStep,
  daemonPath,
  logFailure,
  machineName,
  prepareGuest,
  untilBooted,
} from "../machine-workspaces";
import type {
  GuestFile,
  GuestOps,
  GuestSetup,
  MachineStream,
  WorkspaceBackendOptions,
  WorkspaceMachine,
  WorkspaceMachines,
  WorkspaceSize,
} from "../machine-workspaces";
import {
  DesktopStartFailed,
  WorkspaceRemoveFailed,
  WorkspaceStopFailed,
  WorkspaceStreamFailed,
  WorkspaceUnreachable,
} from "../workspace-errors";
import { startWorkspaceProxy } from "../workspace-proxy";
import type { WorkspaceInterceptor, WorkspaceProxy } from "../workspace-proxy";
import {
  GUEST_PROXY_PORT,
  TUNNEL_SCRIPT,
  serveTunnel,
} from "./workspace-tunnel";

const STREAM_SCRIPT = path.join(import.meta.dir, "railway-stream.py");
const GUEST_STREAM = `${GUEST_HELPERS}/railway-stream.py`;
const GUEST_PYTHON = "/usr/bin/python3";
const GUEST_TUNNEL = `${GUEST_HELPERS}/workspace-tunnel.py`;

const TUNNEL_RESTART_MS = 1000;
const GUEST_PROXY = `http://127.0.0.1:${GUEST_PROXY_PORT}`;

const PROXY_ENV = {
  HTTPS_PROXY: GUEST_PROXY,
  https_proxy: GUEST_PROXY,
  NO_PROXY: "localhost,127.0.0.1",
  no_proxy: "localhost,127.0.0.1",
};

const ARCHIVE = "/tmp/crumble-workspace.tgz";
const DESKTOP_START_TIMEOUT_SEC = 120;

const GUEST_ENV = { ...BASE_ENV, ...DESKTOP_ENV };

const DEFAULT_CHECKPOINT_DELAY_MS = 30_000;

const RAILWAY_IDLE_TIMEOUT_MINUTES = 30;

const HEARTBEAT_MS = 10_000;

const GH_ARCHIVE = `gh_${GH.version}_linux_amd64`;

const gitTemplateSteps = readdirSync(GIT_TEMPLATE_SOURCES, {
  recursive: true,
  withFileTypes: true,
})
  .filter((entry) => entry.isFile())
  .map((entry) => path.join(entry.parentPath, entry.name))
  .toSorted()
  .map((source) => {
    const target = path.posix.join(
      GIT_TEMPLATE_DIR,
      path.relative(GIT_TEMPLATE_SOURCES, source),
    );

    return `mkdir -p ${path.posix.dirname(target)} && echo ${readFileSync(source).toString("base64")} | base64 -d > ${target} && chmod 755 ${target}`;
  });

export const BASE_RECIPE = {
  packages: BASE_PACKAGES,
  steps: [
    `curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh`,
    `curl -fsSL https://bun.sh/install | env BUN_INSTALL=/usr/local bash -s bun-v${BUN_VERSION}`,
    "ln -sf bun /usr/local/bin/bunx",
    `curl -fsSLo /tmp/${GH_ARCHIVE}.tgz https://github.com/cli/cli/releases/download/v${GH.version}/${GH_ARCHIVE}.tar.gz`,
    `echo "${GH.sha256.amd64}  /tmp/${GH_ARCHIVE}.tgz" | sha256sum -c -`,
    `tar -xzf /tmp/${GH_ARCHIVE}.tgz -C /tmp`,
    `install -m 755 /tmp/${GH_ARCHIVE}/bin/gh /usr/local/bin/gh`,
    `rm -rf /tmp/${GH_ARCHIVE} /tmp/${GH_ARCHIVE}.tgz`,
    ...gitTemplateSteps,
    `mkdir -p ${WORKSPACE_PATH}`,
  ],
};

type Recipe = typeof BASE_RECIPE;

const PLAYWRIGHT_VERSION = "1.64.1";

const CHROMIUM_REVISION = "1706547";

const CHROMIUM_SHA256 =
  "4388c45a42d73f45141d22d08518393b52a2398933521a6ce67482e59284a69c";

export const DESKTOP_RECIPE: Recipe = {
  packages: [...BASE_RECIPE.packages, ...DESKTOP_PACKAGES],
  steps: [
    ...BASE_RECIPE.steps,

    `bash -lc 'npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium'`,
    `curl -fsSLo /tmp/chromium.zip https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/${CHROMIUM_REVISION}/chrome-linux.zip`,
    `echo "${CHROMIUM_SHA256}  /tmp/chromium.zip" | sha256sum -c -`,
    "unzip -q /tmp/chromium.zip -d /tmp && rm /tmp/chromium.zip",

    "rm -rf /usr/lib/chromium && mv /tmp/chrome-linux /usr/lib/chromium && mv /usr/lib/chromium/chrome /usr/lib/chromium/chromium",
    "ln -sf /usr/lib/chromium/chromium /usr/local/bin/chromium",
    `curl -fsSLo /tmp/cua-driver.tgz https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER.version}/cua-driver-rs-${CUA_DRIVER.version}-linux-x86_64-binary.tar.gz`,
    `echo "${CUA_DRIVER.sha256.x86_64}  /tmp/cua-driver.tgz" | sha256sum -c -`,
    "tar -xzf /tmp/cua-driver.tgz -C /usr/local/bin cua-driver && rm /tmp/cua-driver.tgz",
    `${envWords(DESKTOP_ENV)} cua-driver telemetry disable`,
  ],
};

const imageName = (kind: string, recipe: Recipe) =>
  `railway-${kind}-${createHash("sha256").update(JSON.stringify(recipe)).digest("hex").slice(0, 12)}`;

export type RailwayWorkspacesOptions = Omit<
  WorkspaceBackendOptions,
  "baseImage"
> & {
  region?: string;
  checkpointDelayMs?: number;
};

export function railwayWorkspacesFromEnv(
  env: Record<string, string | undefined>,
  options: WorkspaceBackendOptions,
) {
  if (env["CRUMBLE_WORKSPACE_BACKEND"] !== "railway") {
    return;
  }

  const region = env["CRUMBLE_RAILWAY_REGION"];

  const { baseImage: _unused, ...railway } = options;

  return new RailwayWorkspaces({ ...railway, ...(region && { region }) });
}

export class RailwayWorkspaces extends MachineWorkspaces {
  constructor(options: RailwayWorkspacesOptions) {
    const machines = new RailwayMachines(options);

    super(machines, machines.baseImage, {
      ...options,
      desktopImage: machines.desktopImage,
    });
  }
}

const machineRecord = z.object({
  image: z.string(),
  sandboxId: z.string().optional(),
});

type MachineRecord = z.infer<typeof machineRecord>;

export class RailwayMachines implements WorkspaceMachines {
  readonly kind = "railway";
  readonly proxyEnv: Record<string, string> | undefined;
  readonly baseImage = imageName("base", BASE_RECIPE);
  readonly desktopImage = imageName("desktop", DESKTOP_RECIPE);
  private readonly recipes = new Map([
    [this.baseImage, BASE_RECIPE],
    [this.desktopImage, DESKTOP_RECIPE],
  ]);
  private readonly templates = new Map<string, Promise<SandboxTemplate>>();
  private readonly records: string;
  private readonly namePrefix: string;
  private readonly region: string | undefined;
  private readonly size: () => WorkspaceSize;
  private readonly checkpointDelayMs: number;
  private readonly intercept:
    | ((agentId: string) => WorkspaceInterceptor)
    | undefined;

  private readonly daemon = daemonPath("x64");

  constructor(options: RailwayWorkspacesOptions) {
    this.records = path.join(options.dataDir, "workspaces", "railway");
    this.namePrefix = options.namePrefix;
    this.region = options.region;
    this.size = options.size;
    this.checkpointDelayMs =
      options.checkpointDelayMs ?? DEFAULT_CHECKPOINT_DELAY_MS;
    this.intercept = options.intercept;
    this.proxyEnv = options.intercept && PROXY_ENV;
  }

  name(agentId: string) {
    return machineName(this.namePrefix, agentId);
  }

  readonly boot = Effect.fn("RailwayMachines.boot")(function* (
    this: RailwayMachines,
    agentId: string,
    image: string,
    desktop: boolean,
    guest: GuestSetup = NO_GUEST,
  ) {
    if (!this.recipes.has(image)) {
      return yield* Effect.die(
        new Error(`Railway workspaces have no image ${image}`),
      );
    }

    const name = this.name(agentId);
    const record = yield* Effect.promise(() => this.readRecord(agentId));
    const machine = yield* this.sandbox(agentId, name, image, record);

    yield* prepareGuest(agentId, this.ops(machine), guest, desktop);

    const intercept = this.intercept;

    const proxy = intercept
      ? yield* bootStep("Starting the workspace proxy", () =>
          startWorkspaceProxy({ intercept: intercept(agentId) }),
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

    if (running && !reconnected) {
      yield* bootStep("Checkpointing the sandbox's other image", async () => {
        await checkpoint(running, name);
        await running.destroy();
      });
    }

    return (
      reconnected ??
      (yield* untilBooted(
        bootStep("Creating the sandbox", () =>
          this.create(agentId, name, image, record),
        ),
        (sandbox) => sandbox.destroy().catch(() => {}),
      ))
    );
  });

  remove(agentId: string) {
    const name = this.name(agentId);

    return Effect.tryPromise({
      try: async () => {
        const sandboxId = (await this.readRecord(agentId))?.sandboxId;
        const running = sandboxId && (await connectRunning(sandboxId));

        if (running) {
          await running.destroy();
        }

        await deleteCheckpoints(name);
        await rm(this.recordPath(agentId), { force: true });
      },
      catch: (cause) =>
        new WorkspaceRemoveFailed({
          message: `Removing the workspace failed: ${errorText(cause)}`,
          cause,
        }),
    });
  }

  private ops(machine: Sandbox): GuestOps {
    return {
      writeStep: "Writing the guest files",
      files: async (desktop) => [
        {
          path: GUEST_DAEMON,
          content: await readFile(this.daemon),
          mode: 0o755,
        },
        { path: GUEST_STREAM, content: await readFile(STREAM_SCRIPT) },
        { path: GUEST_TUNNEL, content: await readFile(TUNNEL_SCRIPT) },
        ...(desktop ? await desktopFiles() : []),
      ],
      write: async (files) => {
        await Promise.all(
          files.map(({ path, content, mode }) =>
            machine.files.write(
              path,
              content,
              ...(mode === undefined ? [] : [{ mode }]),
            ),
          ),
        );
      },
      run: (command) => run(machine, command),
      startDesktop: (...args) => startDesktop(machine, ...args),
      concurrency: "unbounded",
    };
  }

  private async create(
    agentId: string,
    name: string,
    image: string,
    record: MachineRecord | undefined,
  ) {
    const { cpus, memoryMib } = this.size();

    const options = {
      resources: { cpu: cpus, memoryGB: memoryMib / 1024 },
      idleTimeoutMinutes: RAILWAY_IDLE_TIMEOUT_MINUTES,
      env: GUEST_ENV,
    };

    const saved = record !== undefined && (await hasCheckpoint(name));

    if (saved && record.image === image) {
      const sandbox = await Sandbox.create(name, options);

      await this.writeRecord(agentId, { image, sandboxId: sandbox.id });

      return sandbox;
    }

    const sandbox = await Sandbox.create(await this.buildTemplate(image), {
      ...options,
      ...(this.region && { region: this.region }),
    });

    try {
      if (saved) {
        await copyWorkspace(name, sandbox, options);

        await checkpoint(sandbox, name);
      }

      await this.writeRecord(agentId, { image, sandboxId: sandbox.id });
    } catch (error) {
      await sandbox.destroy().catch(() => {});
      throw error;
    }

    return sandbox;
  }

  private buildTemplate(image: string) {
    let template = this.templates.get(image);

    if (!template) {
      const recipe = this.recipes.get(image);

      if (!recipe) {
        throw new Error(`${image} is not a Railway workspace image`);
      }

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
      return;
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

    if (proxy) {
      void this.openTunnel(proxy);
    }
  }

  private async openTunnel(proxy: WorkspaceProxy) {
    if (this.stopped) {
      return;
    }

    const [host, port] = proxy.address.split(":");

    try {
      const tunnel = serveTunnel(
        this.open(GUEST_PYTHON, [GUEST_TUNNEL, String(GUEST_PROXY_PORT)]),
        () => net.connect(Number(port), host),
      );

      this.tunnel = tunnel;
      await tunnel.done;
    } catch {}

    if (this.stopped) {
      return;
    }
    setTimeout(() => void this.openTunnel(proxy), TUNNEL_RESTART_MS).unref();
  }

  private async beat() {
    const alive = await this.sandbox.heartbeat().then(
      (sandbox) => sandbox.status === "RUNNING",

      () => this.alive().catch(() => true),
    );

    if (alive) {
      return;
    }

    clearInterval(this.heartbeat);

    for (const stream of this.streams) {
      stream.fail(new Error("Railway destroyed the sandbox"));
    }
  }

  get desktopReady() {
    return this.desktop ? startDesktop(this.sandbox) : Effect.void;
  }

  get isAlive() {
    return Effect.tryPromise({
      try: () => this.alive(),
      catch: (cause) =>
        new WorkspaceUnreachable({
          message: `Railway could not report on the sandbox: ${errorText(cause)}`,
          cause,
        }),
    });
  }

  stream(command: string, args: ReadonlyArray<string>) {
    return Effect.try({
      try: () => this.open(command, args),
      catch: (cause) =>
        new WorkspaceStreamFailed({
          message: `${command} did not start: ${errorText(cause)}`,
          cause,
        }),
    });
  }

  private alive() {
    return this.sandbox.refresh().then(
      (sandbox) => sandbox.status === "RUNNING",
      (error: unknown) => {
        if (error instanceof SandboxNotFoundError) {
          return false;
        }

        throw error;
      },
    );
  }

  private open(command: string, args: ReadonlyArray<string>): MachineStream {
    const output = new ByteQueue();
    let pending = "";

    this.streams.add(output);

    const exec = this.sandbox.exec(
      [GUEST_PYTHON, GUEST_STREAM, command, ...args].map(shellQuote).join(" "),
      {
        stdin: true,
        ephemeral: true,
        captureOutput: false,
        onStdout: (text) => {
          pending += text;

          const lines = pending.split("\n");

          pending = lines.pop() ?? "";

          for (const line of lines) {
            output.push(Buffer.from(line, "base64"));
          }
        },
      },
    );

    exec
      .finally(() => this.streams.delete(output))
      .then(
        () => output.end(),
        (error: unknown) =>
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

  get stop() {
    return Effect.tryPromise({
      try: async () => {
        this.stopped = true;
        clearTimeout(this.checkpointTimer);
        clearInterval(this.heartbeat);
        await this.tunnel?.close();
        await this.proxy?.close();

        if (await this.alive()) {
          await this.checkpoint();
        }

        await this.sandbox.destroy().catch(() => {});
      },
      catch: (cause) =>
        new WorkspaceStopFailed({
          message: `Stopping the sandbox failed: ${errorText(cause)}`,
          cause,
        }),
    });
  }

  private checkpoint() {
    const next = this.checkpointing
      .catch(() => {})
      .then(() => checkpoint(this.sandbox, this.name));

    this.checkpointing = next;

    return next;
  }
}

async function desktopFiles(): Promise<Array<GuestFile>> {
  const files = await readdir(DESKTOP_SOURCES);

  return Promise.all(
    files.map(async (file) => ({
      path: `${GUEST_FILES}/${file}`,
      content: await readFile(path.join(DESKTOP_SOURCES, file)),
      mode: file.endsWith(".sh") ? 0o755 : 0o644,
    })),
  );
}

const startDesktop = Effect.fn("startDesktop")(function* (
  sandbox: Sandbox,
  ...args: Array<string>
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      sandbox.exec([DESKTOP_START, ...args].join(" "), {
        timeoutSec: DESKTOP_START_TIMEOUT_SEC,
      }),
    catch: (cause) =>
      new DesktopStartFailed({
        message: `The bot desktop did not start: ${errorText(cause)}`,
        cause,
      }),
  });

  if (result.exitCode !== 0) {
    return yield* new DesktopStartFailed({
      message: `The bot desktop did not start: ${result.stderr}`,
      cause: result.stderr,
    });
  }
});

async function checkpoint(sandbox: Sandbox, name: string) {
  await run(sandbox, "sync");
  await sandbox.checkpoint(name);
}

async function connectRunning(id: string) {
  try {
    const sandbox = await Sandbox.connect(id);

    return sandbox.status === "RUNNING" ? sandbox : undefined;
  } catch (error) {
    if (error instanceof SandboxNotFoundError) {
      return;
    }

    throw error;
  }
}

async function hasCheckpoint(name: string) {
  return (await Sandbox.checkpoints()).some(
    (checkpoint) => checkpoint.key === name,
  );
}

async function deleteCheckpoints(name: string) {
  for (const each of await Sandbox.checkpoints()) {
    if (each.key === name) {
      await Sandbox.deleteCheckpoint(each.id);
    }
  }
}

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
    await source.destroy().catch(() => {});
  }
}

async function run(sandbox: Sandbox, command: string) {
  const result = await sandbox.exec(command);

  if (result.exitCode !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
}

class ByteQueue implements AsyncIterable<Uint8Array> {
  private readonly chunks: Array<Uint8Array> = [];
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
      const chunk = await this.next();

      if (!chunk) {
        return;
      }

      yield chunk;
    }
  }

  private async next(): Promise<Uint8Array | undefined> {
    while (true) {
      const chunk = this.chunks.shift();

      if (chunk) {
        return chunk;
      }

      if (this.done) {
        return this.stop();
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }

  private stop(): undefined {
    if (this.error) {
      throw this.error;
    }

    return undefined;
  }
}
