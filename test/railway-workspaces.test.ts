import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { Sandbox } from "railway";
import {
  RailwayWorkspaces,
  railwayWorkspacesFromEnv,
} from "../src/railway-workspaces";
import { WORKSPACE_PATH } from "../src/workspace";

// Live tests create billed sandboxes, so they need an explicit opt-in besides the credentials.
const railwayTests =
  process.env.CRUMBLE_RAILWAY_TESTS === "1" &&
  Boolean(process.env.RAILWAY_TOKEN ?? process.env.RAILWAY_API_TOKEN);

// Checkpoint names are global to the Railway environment, so each run gets its own.
const namePrefix = `crumble-test-${process.pid}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "crumble-railway-test-"));
const recordsDir = path.join(dataDir, "workspaces", "railway");

async function sh(env: ExecutionEnv, command: string) {
  let output = "";

  const result = await env.exec(
    command,
    { onOutput: (text) => (output += text) },
    BACKGROUND_CONTEXT,
  );

  assert(result.ok);

  return { exitCode: result.value.exitCode, output: output.trim() };
}

async function readText(env: ExecutionEnv, file: string) {
  const result = await env.readTextFile(file, BACKGROUND_CONTEXT);

  assert(result.ok, result.ok ? "" : result.error.message);

  return result.value;
}

const recordFile = (agentId: string) =>
  path.join(recordsDir, `${agentId}.json`);

const isRunning = (sandboxId: string) =>
  Sandbox.connect(sandboxId).then(
    (sandbox) => sandbox.status === "RUNNING",
    () => false,
  );

const readRecord = (agentId: string): { image: string; sandboxId?: string } =>
  JSON.parse(readFileSync(recordFile(agentId), "utf8"));

describe("Railway workspace configuration", () => {
  test("workspaces are unavailable unless Railway is the backend", () => {
    expect(railwayWorkspacesFromEnv({}, { dataDir })).toBeUndefined();
    expect(
      railwayWorkspacesFromEnv(
        { CRUMBLE_WORKSPACE_BACKEND: "railway" },
        { dataDir },
      ),
    ).toBeInstanceOf(RailwayWorkspaces);
  });

  test("Railway workspaces have no bot desktop yet", () => {
    const workspaces = new RailwayWorkspaces({
      dataDir,
      wantsDesktop: () => true,
    });

    expect(workspaces.desktop).toBe(false);
    expect(workspaces.imageFor("desk")).toStartWith("railway-base-");
  });

  test("agent ids cannot name another machine", () => {
    const workspaces = new RailwayWorkspaces({ dataDir });

    for (const agentId of ["", "../other", "a/b", "x".repeat(65)])
      expect(() => workspaces.env(agentId)).toThrow("Invalid agent id");
  });
});

describe.skipIf(!railwayTests)("Railway sandbox workspaces", () => {
  const workspaces = new RailwayWorkspaces({ dataDir, namePrefix });

  afterAll(async () => {
    await workspaces.close();

    for (const file of readdirSync(recordsDir)) {
      const { sandboxId } = readRecord(path.basename(file, ".json"));

      if (sandboxId)
        await Sandbox.connect(sandboxId)
          .then((sandbox) => sandbox.destroy())
          .catch(() => undefined);
    }

    for (const checkpoint of await Sandbox.checkpoints())
      if (checkpoint.key.startsWith(`${namePrefix}-`))
        await Sandbox.deleteCheckpoint(checkpoint.id);
  }, 120_000);

  const env = () => workspaces.env("conformance");

  const cases = createEnvConformance({
    listFiles: true,
    assertions: {
      ok: (value, message) =>
        assert.ok(value, message ?? "expected a truthy value"),
      strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
      deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
      partialDeepEqual: (actual, expected) =>
        assert.partialDeepStrictEqual(actual, expected),
      greaterThan: (actual, expected) =>
        assert.ok(actual > expected, `${actual} > ${expected}`),
      rejects: (operation, messageIncludes) =>
        assert.rejects(operation, (error) =>
          String(error instanceof Error ? error.message : error).includes(
            messageIncludes,
          ),
        ),
    },
    withEnv: async (use) => {
      await sh(env(), `find ${WORKSPACE_PATH} -mindepth 1 -delete`);
      await use(env());
    },
  });

  for (const conformance of cases)
    test(
      `env conformance: ${conformance.name}`,
      () => conformance.run(),
      conformance.timeoutMs ?? 120_000,
    );

  test("files survive a stop through the checkpoint", async () => {
    const first = new RailwayWorkspaces({ dataDir, namePrefix });

    await sh(first.env("persist"), "echo kept > /workspace/note");
    const { sandboxId } = readRecord("persist");
    await first.close();

    const second = new RailwayWorkspaces({ dataDir, namePrefix });

    try {
      expect(await readText(second.env("persist"), "/workspace/note")).toBe(
        "kept\n",
      );
      expect(readRecord("persist").sandboxId).not.toBe(sandboxId);
    } finally {
      await second.close();
    }
  }, 300_000);

  test("a server that died leaves its sandbox running for the next server", async () => {
    const module = path.join(import.meta.dir, "../src/railway-workspaces.ts");

    // Exits without close(): no checkpoint, the sandbox keeps running.
    const killed = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { RailwayWorkspaces } = await import(${JSON.stringify(module)});
         const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
         const workspaces = new RailwayWorkspaces({ dataDir: ${JSON.stringify(dataDir)}, namePrefix: ${JSON.stringify(namePrefix)} });
         const result = await workspaces.env("orphan").exec("echo unsynced > /workspace/note", {}, BACKGROUND_CONTEXT);
         process.exit(result.ok && result.value.exitCode === 0 ? 0 : 1);`,
      ],
      { cwd: path.join(import.meta.dir, ".."), stderr: "inherit" },
    );

    expect(await killed.exited).toBe(0);

    const { sandboxId } = readRecord("orphan");
    const next = new RailwayWorkspaces({ dataDir, namePrefix });

    try {
      expect(await readText(next.env("orphan"), "/workspace/note")).toBe(
        "unsynced\n",
      );
      expect(readRecord("orphan").sandboxId).toBe(sandboxId);
    } finally {
      await next.close();
    }
  }, 300_000);

  test("a synced workspace comes back from its checkpoint after Railway lost the sandbox", async () => {
    const lossy = new RailwayWorkspaces({
      dataDir,
      namePrefix,
      checkpointDelayMs: 500,
    });

    try {
      await sh(lossy.env("lost"), "echo kept > /workspace/note");
      await lossy.sync("lost");
      await Bun.sleep(20_000);

      const { sandboxId } = readRecord("lost");
      await (await Sandbox.connect(sandboxId!)).destroy();
      // A call in flight when the sandbox goes fails; the heartbeat notices within seconds and the next call boots.
      await Bun.sleep(15_000);

      expect(await readText(lossy.env("lost"), "/workspace/note")).toBe(
        "kept\n",
      );
    } finally {
      await lossy.close();
    }
  }, 300_000);

  test("an idle workspace stops and starts again with its files", async () => {
    const idle = new RailwayWorkspaces({
      dataDir,
      namePrefix,
      idleTimeoutMs: 500,
    });

    try {
      await sh(idle.env("idle"), "echo kept > /workspace/note");
      const { sandboxId } = readRecord("idle");
      await Bun.sleep(20_000);
      expect(await isRunning(sandboxId!)).toBe(false);

      expect(await readText(idle.env("idle"), "/workspace/note")).toBe(
        "kept\n",
      );
    } finally {
      await idle.close();
    }
  }, 300_000);

  test("a checkpoint of another image moves its workspace to the current one", async () => {
    const first = new RailwayWorkspaces({ dataDir, namePrefix });

    await sh(
      first.env("moved"),
      "mkdir -p /workspace/dir && echo kept > /workspace/dir/note",
    );
    await first.close();

    writeFileSync(
      recordFile("moved"),
      JSON.stringify({ ...readRecord("moved"), image: "railway-base-old" }),
    );

    const second = new RailwayWorkspaces({ dataDir, namePrefix });

    try {
      expect(await readText(second.env("moved"), "/workspace/dir/note")).toBe(
        "kept\n",
      );
      expect(readRecord("moved").image).toBe(second.imageFor("moved"));
    } finally {
      await second.close();
    }
  }, 600_000);
});
