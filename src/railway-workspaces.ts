import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Sandbox, type SandboxResources, type SandboxTemplate } from "railway";
import { z } from "zod";
import {
  GUEST_DAEMON,
  MachineWorkspaces,
  assertAgentId,
  daemonPath,
  type MachineStream,
  type MachineWorkspacesOptions,
  type WorkspaceMachine,
  type WorkspaceMachines,
} from "./machine-workspaces";
import { WORKSPACE_PATH } from "./workspace";

const STREAM_SCRIPT = path.join(import.meta.dir, "railway-stream.py");
const GUEST_STREAM = "/usr/local/lib/crumble/railway-stream.py";
const GUEST_PYTHON = "/usr/bin/python3";
const ARCHIVE = "/tmp/crumble-workspace.tgz";

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

/** Names an image by its recipe, so a changed recipe is a new image that bots move to. */
const imageName = (recipe: Recipe) =>
  `railway-base-${createHash("sha256").update(JSON.stringify(recipe)).digest("hex").slice(0, 12)}`;

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
};

/**
 * The workspaces when `CRUMBLE_WORKSPACE_BACKEND` is `railway`, otherwise undefined. The Railway SDK reads its
 * credentials itself: `RAILWAY_TOKEN` or `RAILWAY_API_TOKEN`, and `RAILWAY_ENVIRONMENT_ID`.
 */
export function railwayWorkspacesFromEnv(
  env: Record<string, string | undefined>,
  options: RailwayWorkspacesOptions,
) {
  if (env.CRUMBLE_WORKSPACE_BACKEND !== "railway") return undefined;

  const region = env.CRUMBLE_RAILWAY_REGION;

  return new RailwayWorkspaces({ ...options, ...(region && { region }) });
}

/**
 * Railway-backed workspaces: one Railway sandbox per bot. Railway has no volumes, so a bot's files outlive its machine
 * as a named checkpoint of the whole disk: taken after `checkpointDelayMs` without a sync, and before every stop. A
 * server that dies leaves the sandbox running; the next server reconnects to it. Railway has no egress hook, so no
 * network policy applies; sandboxes are isolated from the environment's private network.
 */
export class RailwayWorkspaces extends MachineWorkspaces {
  constructor(options: RailwayWorkspacesOptions) {
    const machines = new RailwayMachines(options);

    super(machines, machines.baseImage, options);
  }
}

const machineRecord = z.object({
  /** The image of the bot's disk, running or checkpointed. */
  image: z.string(),
  /** The sandbox last booted for the bot; it may be gone. */
  sandboxId: z.string().optional(),
});

type MachineRecord = z.infer<typeof machineRecord>;

class RailwayMachines implements WorkspaceMachines {
  readonly kind = "railway";
  readonly baseImage = imageName(BASE_RECIPE);
  private readonly records: string;
  private readonly namePrefix: string;
  private readonly region: string | undefined;
  private readonly resources: SandboxResources;
  private readonly checkpointDelayMs: number;
  // Railway runs x86_64 sandboxes whatever the host is.
  private readonly daemon = daemonPath("x64");
  private template: Promise<SandboxTemplate> | undefined;

  constructor(options: RailwayWorkspacesOptions) {
    this.records = path.join(options.dataDir, "workspaces", "railway");
    this.namePrefix = options.namePrefix ?? "crumble";
    this.region = options.region;
    this.resources = options.resources ?? DEFAULT_RESOURCES;
    this.checkpointDelayMs =
      options.checkpointDelayMs ?? DEFAULT_CHECKPOINT_DELAY_MS;
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
  async boot(agentId: string, image: string): Promise<WorkspaceMachine> {
    if (image !== this.baseImage)
      throw new Error(`Railway workspaces have no image ${image}`);

    const name = this.name(agentId);
    const record = await this.readRecord(agentId);

    let sandbox = record?.sandboxId
      ? await connectRunning(record.sandboxId)
      : undefined;

    if (sandbox && record?.image !== image) {
      // Keep the files it has written since its last checkpoint.
      await checkpoint(sandbox, name);
      await sandbox.destroy();
      sandbox = undefined;
    }

    const reconnected = sandbox !== undefined;

    sandbox ??= await this.create(agentId, name, image, record);

    try {
      await sandbox.files.write(GUEST_DAEMON, await readFile(this.daemon), {
        mode: 0o755,
      });
      await sandbox.files.write(GUEST_STREAM, await readFile(STREAM_SCRIPT));
    } catch (error) {
      // A new sandbox's files are all in the checkpoint; a reconnected one may hold writes the checkpoint lacks.
      if (!reconnected) await sandbox.destroy().catch(() => undefined);
      throw error;
    }

    return new RailwayMachine(sandbox, name, image, this.checkpointDelayMs);
  }

  private async create(
    agentId: string,
    name: string,
    image: string,
    record: MachineRecord | undefined,
  ) {
    const options = {
      resources: this.resources,
      idleTimeoutMinutes: RAILWAY_IDLE_TIMEOUT_MINUTES,
    };

    const saved = record !== undefined && (await hasCheckpoint(name));

    if (saved && record.image === image) {
      const sandbox = await Sandbox.create(name, options);

      await this.writeRecord(agentId, { image, sandboxId: sandbox.id });

      return sandbox;
    }

    const sandbox = await Sandbox.create(await this.buildTemplate(), options);

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
  private buildTemplate() {
    this.template ??= Sandbox.template()
      .withPackages(...BASE_RECIPE.packages)
      .run(BASE_RECIPE.steps.join(" && "))
      .workdir(WORKSPACE_PATH)
      .build(this.region ? { region: this.region } : {});
    this.template.catch(() => (this.template = undefined));

    return this.template;
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

  constructor(
    private readonly sandbox: Sandbox,
    private readonly name: string,
    readonly image: string,
    private readonly checkpointDelayMs: number,
  ) {
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** Ends the streams of a sandbox Railway destroyed, so pi-env reconnects to a new one instead of waiting. */
  private async beat() {
    const alive = await this.sandbox.heartbeat().then(
      (sandbox) => sandbox.status === "RUNNING",
      () => this.isAlive(),
    );

    if (alive) return;

    clearInterval(this.heartbeat);

    for (const stream of this.streams)
      stream.fail(new Error("Railway destroyed the sandbox"));
  }

  isAlive() {
    return this.sandbox.refresh().then(
      (sandbox) => sandbox.status === "RUNNING",
      () => false,
    );
  }

  async stream(
    command: string,
    args: readonly string[],
  ): Promise<MachineStream> {
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
  async sync() {
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = setTimeout(
      () => void this.checkpoint().catch(() => undefined),
      this.checkpointDelayMs,
    );
    this.checkpointTimer.unref();
  }

  /** Destroys the sandbox only after a checkpoint succeeded; otherwise Railway's idle timeout ends it. */
  async stop() {
    clearTimeout(this.checkpointTimer);
    clearInterval(this.heartbeat);

    if (await this.isAlive()) await this.checkpoint();

    await this.sandbox.destroy().catch(() => undefined);
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

/** A checkpoint snapshots the disk, not the guest's page cache, so recent writes need a `sync` first. */
async function checkpoint(sandbox: Sandbox, name: string) {
  await run(sandbox, "sync");
  await sandbox.checkpoint(name);
}

/** The running sandbox with this id, or undefined when Railway has destroyed it. */
async function connectRunning(id: string) {
  try {
    const sandbox = await Sandbox.connect(id);

    return sandbox.status === "RUNNING" ? sandbox : undefined;
  } catch {
    return undefined;
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
