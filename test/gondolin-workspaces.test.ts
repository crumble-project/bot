import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import {
  GondolinWorkspaces,
  gondolinWorkspacesFromEnv,
} from "../src/gondolin-workspaces";
import { WORKSPACE_PATH, type WorkspaceRequest } from "../src/workspace";

const IMAGE = process.env.CRUMBLE_WORKSPACE_IMAGE;
const vmTests = process.env.CRUMBLE_VM_TESTS === "1" && IMAGE !== undefined;

const temps: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "crumble-workspaces-test-"));

  temps.push(dir);

  return dir;
}

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

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

describe("workspace configuration", () => {
  test("workspaces are unavailable without an image", async () => {
    expect(gondolinWorkspacesFromEnv(await tempDir(), {})).toBeUndefined();
  });

  test("agent ids cannot escape the workspaces root", async () => {
    const image = await tempDir();

    await writeFile(
      path.join(image, "manifest.json"),
      JSON.stringify({ buildId: "new", config: { arch: "aarch64" } }),
    );
    const workspaces = new GondolinWorkspaces(await tempDir(), image);

    expect(() => workspaces.env("../other")).toThrow("Invalid agent id");
  });

  test("a disk made from another image fails clearly instead of booting", async () => {
    const image = await tempDir();
    const root = await tempDir();

    await writeFile(
      path.join(image, "manifest.json"),
      JSON.stringify({ buildId: "new", config: { arch: "aarch64" } }),
    );
    const workspaces = new GondolinWorkspaces(root, image);
    const botDir = path.dirname(workspaces.diskPath("bot"));

    await mkdir(botDir, { recursive: true });
    await writeFile(workspaces.diskPath("bot"), "");
    await writeFile(path.join(botDir, "image-build-id"), "old");

    const result = await workspaces
      .env("bot")
      .readTextFile("/workspace/a", BACKGROUND_CONTEXT);

    assert(!result.ok);
    expect(result.error.message).toContain("created from image old");
    await workspaces.close();
  });
});

describe.skipIf(!vmTests)("Gondolin VM workspaces", () => {
  let root: string;
  let workspaces: GondolinWorkspaces;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "crumble-workspaces-vm-"));
    workspaces = new GondolinWorkspaces(root, IMAGE ?? "");
  });

  afterAll(async () => {
    await workspaces.close();
    await rm(root, { recursive: true, force: true });
  });

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
      conformance.timeoutMs ?? 60_000,
    );

  test("files survive a restart on the same disk", async () => {
    const first = new GondolinWorkspaces(root, IMAGE ?? "");

    await sh(first.env("persist"), "echo kept > /workspace/note");
    await first.close();

    const second = new GondolinWorkspaces(root, IMAGE ?? "");

    try {
      expect(await readText(second.env("persist"), "/workspace/note")).toBe(
        "kept\n",
      );
    } finally {
      await second.close();
    }
  }, 120_000);

  test("an image path relative to the working directory boots", async () => {
    const relative = new GondolinWorkspaces(
      root,
      path.relative(process.cwd(), IMAGE ?? ""),
    );

    try {
      expect((await sh(relative.env("relative"), "echo ok")).output).toBe("ok");
    } finally {
      await relative.close();
    }
  }, 120_000);

  test("an idle workspace stops and starts again with its files", async () => {
    const idle = new GondolinWorkspaces(root, IMAGE ?? "", {
      idleTimeoutMs: 500,
    });

    try {
      await sh(idle.env("idle"), "echo kept > /workspace/note");
      await Bun.sleep(5_000);

      expect(await readText(idle.env("idle"), "/workspace/note")).toBe(
        "kept\n",
      );
    } finally {
      await idle.close();
    }
  }, 120_000);

  test("a machine that died restarts on the next operation", async () => {
    const dying = new GondolinWorkspaces(root, IMAGE ?? "");

    try {
      await sh(dying.env("died"), "echo kept > /workspace/note && sync");
      // The command never reports back: the machine goes away under it.
      await dying
        .env("died")
        .exec("poweroff -f", undefined, BACKGROUND_CONTEXT);
      await Bun.sleep(2_000);

      expect(await readText(dying.env("died"), "/workspace/note")).toBe(
        "kept\n",
      );
    } finally {
      await dying.close();
    }
  }, 120_000);

  test("sync is a no-op for a stopped workspace", async () => {
    await workspaces.sync("never-started");
  });

  test("the network policy decides each request before it leaves", async () => {
    const asked: WorkspaceRequest[] = [];

    const denying = new GondolinWorkspaces(root, IMAGE ?? "", {
      network: (request) => {
        asked.push(request);

        return false;
      },
    });

    try {
      const result = await sh(
        denying.env("denied"),
        "curl -sS -m 5 -o /dev/null -w '%{http_code}' https://example.com/path",
      );

      // Gondolin answers a denied request itself, so it never reaches the host.
      expect(result.output).toBe("403");
      expect(asked).toEqual([
        {
          agentId: "denied",
          method: "GET",
          url: "https://example.com/path",
        },
      ]);
    } finally {
      await denying.close();
    }
  }, 120_000);
});
