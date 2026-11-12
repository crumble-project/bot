import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Predicate } from "effect";
import { Sandbox as MicrosandboxSandbox } from "microsandbox";
import { Sandbox as RailwaySandbox } from "railway";
import type { MachineWorkspaces } from "../../src/workspaces/machine-workspaces";
import { MicrosandboxWorkspaces } from "../../src/workspaces/microsandbox-workspaces";
import { RailwayWorkspaces } from "../../src/workspaces/railway/railway-workspaces";

export type BackendWorkspacesOptions = {
  namePrefix: string;
  idleTimeoutMs?: number;
  wantsDesktop: (agentId: string) => boolean;
};

export type WorkspaceBackend = {
  name: string;
  enabled: boolean;
  /** How long the first boot may take; Railway builds the desktop template on first use. */
  firstBootTimeoutMs: number;
  create(options: BackendWorkspacesOptions): BackendWorkspaces;
  cleanup(namePrefix: string): Promise<void>;
};

export type BackendWorkspaces = {
  workspaces: MachineWorkspaces;
  isRunning: (agentId: string) => Promise<boolean>;
};

const size = () => ({ cpus: 2, memoryMib: 4096 });

const IMAGE = process.env["CRUMBLE_WORKSPACE_IMAGE"] ?? "";
const DESKTOP_IMAGE = process.env["CRUMBLE_WORKSPACE_DESKTOP_IMAGE"] ?? "";

const microsandbox: WorkspaceBackend = {
  name: "Microsandbox",
  enabled:
    process.env["CRUMBLE_VM_TESTS"] === "1" &&
    IMAGE !== "" &&
    DESKTOP_IMAGE !== "",
  firstBootTimeoutMs: 120_000,
  create: (options) => {
    const workspaces = new MicrosandboxWorkspaces(IMAGE, {
      ...options,
      size,
      desktopImage: DESKTOP_IMAGE,
    });

    return {
      workspaces,
      isRunning: async (agentId) =>
        (await MicrosandboxSandbox.get(workspaces.name(agentId))).status ===
        "running",
    };
  },
  cleanup: async () => {},
};

const railwayDataDir = mkdtempSync(path.join(tmpdir(), "crumble-railway-"));
const railwayRecords = path.join(railwayDataDir, "workspaces", "railway");

const railwaySandboxId = (agentId: string): string | undefined => {
  try {
    const record: unknown = JSON.parse(
      readFileSync(path.join(railwayRecords, `${agentId}.json`), "utf8"),
    );

    return Predicate.isObject(record) && Predicate.isString(record["sandboxId"])
      ? record["sandboxId"]
      : undefined;
  } catch {
    return undefined;
  }
};

const destroyRecordedSandboxes = async () => {
  const files = existsSync(railwayRecords) ? readdirSync(railwayRecords) : [];

  for (const file of files) {
    const id = railwaySandboxId(path.basename(file, ".json"));

    if (id)
      await RailwaySandbox.connect(id)
        .then((sandbox) => sandbox.destroy())
        .catch(() => {});
  }
};

const deleteRunCheckpoints = async (namePrefix: string) => {
  for (const checkpoint of await RailwaySandbox.checkpoints())
    if (checkpoint.key.startsWith(`${namePrefix}-`))
      await RailwaySandbox.deleteCheckpoint(checkpoint.id);
};

const railway: WorkspaceBackend = {
  name: "Railway",
  enabled:
    process.env["CRUMBLE_RAILWAY_TESTS"] === "1" &&
    Boolean(process.env["RAILWAY_TOKEN"] ?? process.env["RAILWAY_API_TOKEN"]),
  firstBootTimeoutMs: 1_200_000,
  create: (options) => ({
    workspaces: new RailwayWorkspaces({
      ...options,
      size,
      dataDir: railwayDataDir,
      ...(process.env["CRUMBLE_RAILWAY_REGION"] && {
        region: process.env["CRUMBLE_RAILWAY_REGION"],
      }),
    }),
    isRunning: async (agentId) => {
      const id = railwaySandboxId(agentId);

      return id
        ? RailwaySandbox.connect(id).then(
            (sandbox) => sandbox.status === "RUNNING",
            () => false,
          )
        : false;
    },
  }),
  cleanup: async (namePrefix) => {
    await destroyRecordedSandboxes();
    await deleteRunCheckpoints(namePrefix);
  },
};

export const WORKSPACE_BACKENDS = [microsandbox, railway];

export async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (!(await check())) {
    if (Date.now() > deadline) return false;

    await Bun.sleep(500);
  }

  return true;
}
