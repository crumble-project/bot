import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Sandbox as MicrosandboxSandbox } from "microsandbox";
import { Sandbox as RailwaySandbox } from "railway";
import type { MachineWorkspaces } from "../../src/machine-workspaces";
import { MicrosandboxWorkspaces } from "../../src/microsandbox-workspaces";
import { RailwayWorkspaces } from "../../src/railway-workspaces";

export type BackendWorkspacesOptions = {
  namePrefix: string;
  idleTimeoutMs?: number;
  wantsDesktop: (agentId: string) => boolean;
};

/** A workspace backend the desktop VM tests run against, when its machines are available. */
export type WorkspaceBackend = {
  name: string;
  enabled: boolean;
  /** How long the first boot may take; Railway builds the desktop template on first use. */
  firstBootTimeoutMs: number;
  create(options: BackendWorkspacesOptions): BackendWorkspaces;
  /** Removes what the run left behind in global names. */
  cleanup(namePrefix: string): Promise<void>;
};

export type BackendWorkspaces = {
  workspaces: MachineWorkspaces;
  isRunning: (agentId: string) => Promise<boolean>;
};

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
      desktopImage: DESKTOP_IMAGE,
    });

    return {
      workspaces,
      isRunning: async (agentId) =>
        (await MicrosandboxSandbox.get(workspaces.name(agentId))).status ===
        "running",
    };
  },
  cleanup: async () => undefined,
};

// Records of every Railway run in this process, so cleanup finds its sandboxes.
const railwayDataDir = mkdtempSync(path.join(tmpdir(), "crumble-railway-"));
const railwayRecords = path.join(railwayDataDir, "workspaces", "railway");

const railwaySandboxId = (agentId: string): string | undefined => {
  try {
    return JSON.parse(
      readFileSync(path.join(railwayRecords, `${agentId}.json`), "utf8"),
    ).sandboxId;
  } catch {
    return undefined;
  }
};

const railway: WorkspaceBackend = {
  name: "Railway",
  // Live runs create billed sandboxes, so they need an explicit opt-in besides the credentials.
  enabled:
    process.env["CRUMBLE_RAILWAY_TESTS"] === "1" &&
    Boolean(process.env["RAILWAY_TOKEN"] ?? process.env["RAILWAY_API_TOKEN"]),
  firstBootTimeoutMs: 1_200_000,
  create: (options) => ({
    workspaces: new RailwayWorkspaces({
      ...options,
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
    // Only the sandboxes this run recorded: the environment may hold others.
    for (const file of existsSync(railwayRecords)
      ? readdirSync(railwayRecords)
      : []) {
      const id = railwaySandboxId(path.basename(file, ".json"));

      if (id)
        await RailwaySandbox.connect(id)
          .then((sandbox) => sandbox.destroy())
          .catch(() => undefined);
    }

    for (const checkpoint of await RailwaySandbox.checkpoints())
      if (checkpoint.key.startsWith(`${namePrefix}-`))
        await RailwaySandbox.deleteCheckpoint(checkpoint.id);
  },
};

export const WORKSPACE_BACKENDS = [microsandbox, railway];

/** Waits until `check` holds, or fails after `timeoutMs`; stopping a Railway machine takes a checkpoint first. */
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
