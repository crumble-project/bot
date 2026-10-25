import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { Sandbox } from "microsandbox";
import {
  MicrosandboxWorkspaces,
  microsandboxWorkspacesFromEnv,
} from "../src/microsandbox-workspaces";
import { WORKSPACE_PATH, type WorkspaceRequest } from "../src/workspace";

const IMAGE = process.env["CRUMBLE_WORKSPACE_IMAGE"] ?? "";
const vmTests = process.env["CRUMBLE_VM_TESTS"] === "1" && IMAGE !== "";

// The same image under another tag, for the image change test.
const OTHER_IMAGE = process.env["CRUMBLE_WORKSPACE_IMAGE_OTHER"] ?? "";

// Sandboxes and volumes are global to the Microsandbox home, so each run gets its own names.
const namePrefix = `crumble-test-${process.pid}`;

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
  test("workspaces are unavailable without an image", () => {
    expect(microsandboxWorkspacesFromEnv({})).toBeUndefined();
  });

  test("desktop bots boot the desktop image when one is configured", () => {
    const desktopBots = new Set(["desk"]);

    const workspaces = microsandboxWorkspacesFromEnv(
      {
        CRUMBLE_WORKSPACE_IMAGE: "crumble-workspace:dev",
        CRUMBLE_WORKSPACE_DESKTOP_IMAGE: "crumble-workspace-desktop:dev",
      },
      { wantsDesktop: (agentId) => desktopBots.has(agentId) },
    )!;

    expect(workspaces.desktop).toBe(true);
    expect(workspaces.imageFor("desk")).toBe("crumble-workspace-desktop:dev");
    expect(workspaces.imageFor("plain")).toBe("crumble-workspace:dev");
  });

  test("without a desktop image no bot gets a bot desktop", () => {
    const workspaces = microsandboxWorkspacesFromEnv(
      { CRUMBLE_WORKSPACE_IMAGE: "crumble-workspace:dev" },
      { wantsDesktop: () => true },
    )!;

    expect(workspaces.desktop).toBe(false);
    expect(workspaces.imageFor("desk")).toBe("crumble-workspace:dev");
  });

  test("agent ids cannot name another machine", () => {
    const workspaces = new MicrosandboxWorkspaces("crumble-workspace:dev");

    for (const agentId of ["", "../other", "a/b", "x".repeat(65)])
      expect(() => workspaces.env(agentId)).toThrow("Invalid agent id");
  });
});

describe.skipIf(!vmTests)("Microsandbox VM workspaces", () => {
  const workspaces = new MicrosandboxWorkspaces(IMAGE, { namePrefix });

  afterAll(() => workspaces.close());

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

  test("files survive a restart on the same volume", async () => {
    const first = new MicrosandboxWorkspaces(IMAGE, { namePrefix });

    await sh(first.env("persist"), "echo kept > /workspace/note");
    await first.close();

    const second = new MicrosandboxWorkspaces(IMAGE, { namePrefix });

    try {
      expect(await readText(second.env("persist"), "/workspace/note")).toBe(
        "kept\n",
      );
    } finally {
      await second.close();
    }
  }, 120_000);

  test("a machine left behind by a killed server is taken over on the next boot", async () => {
    const module = path.join(
      import.meta.dir,
      "../src/microsandbox-workspaces.ts",
    );

    const owner = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { MicrosandboxWorkspaces } = await import(${JSON.stringify(module)});
         const workspaces = new MicrosandboxWorkspaces(${JSON.stringify(IMAGE)}, { namePrefix: ${JSON.stringify(namePrefix)} });
         const result = await workspaces.env("orphaned").exec("echo kept > /workspace/note && echo installed > /usr/local/bin/marker && sync", {}, (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT);
         console.log(result.ok ? "ready" : "failed");
         setInterval(() => {}, 1000);`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );

    const reader = owner.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "ready",
    );
    // A crash or SIGKILL skips every shutdown handler.
    owner.kill("SIGKILL");
    await owner.exited;

    const next = new MicrosandboxWorkspaces(IMAGE, { namePrefix });

    try {
      expect(await readText(next.env("orphaned"), "/workspace/note")).toBe(
        "kept\n",
      );
      // Taken over, not replaced: what was installed outside the workspace is still there.
      expect(
        await readText(next.env("orphaned"), "/usr/local/bin/marker"),
      ).toBe("installed\n");
    } finally {
      await next.close();
    }
  }, 180_000);

  test("programs outside the workspace survive an idle stop and a server restart", async () => {
    const first = new MicrosandboxWorkspaces(IMAGE, {
      namePrefix,
      idleTimeoutMs: 500,
    });

    try {
      await sh(
        first.env("keeps"),
        "echo installed > /usr/local/bin/marker && sync",
      );
      await Bun.sleep(5_000);
      expect((await Sandbox.get(first.name("keeps"))).status).toBe("stopped");
      expect(await readText(first.env("keeps"), "/usr/local/bin/marker")).toBe(
        "installed\n",
      );
    } finally {
      await first.close();
    }

    // A new server process: a new MicrosandboxWorkspaces, the same machine.
    const second = new MicrosandboxWorkspaces(IMAGE, { namePrefix });

    try {
      expect(await readText(second.env("keeps"), "/usr/local/bin/marker")).toBe(
        "installed\n",
      );

      // The machine's network still reaches its proxy, now started again at the port it was created with.
      const https = await sh(
        second.env("keeps"),
        "curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.com",
      );

      expect(https.output).toBe("200");
    } finally {
      await second.close();
    }
  }, 180_000);

  // A second tag of the same image stands in for an image change without a second build.
  test.skipIf(!OTHER_IMAGE)(
    "another image replaces the machine but keeps the workspace",
    async () => {
      const first = new MicrosandboxWorkspaces(IMAGE, { namePrefix });

      try {
        await sh(
          first.env("swap"),
          "echo kept > /workspace/note && echo installed > /usr/local/bin/marker && sync",
        );
      } finally {
        await first.close();
      }

      const second = new MicrosandboxWorkspaces(OTHER_IMAGE, { namePrefix });

      try {
        const result = await sh(
          second.env("swap"),
          "cat /workspace/note; cat /usr/local/bin/marker 2>/dev/null || echo none",
        );

        expect(result.output).toBe("kept\nnone");
      } finally {
        await second.close();
      }
    },
    180_000,
  );

  test("an idle workspace stops and starts again with its files", async () => {
    const idle = new MicrosandboxWorkspaces(IMAGE, {
      namePrefix,
      idleTimeoutMs: 500,
    });

    try {
      await sh(idle.env("idle"), "echo kept > /workspace/note");
      await Bun.sleep(5_000);
      expect((await Sandbox.get(idle.name("idle"))).status).toBe("stopped");

      expect(await readText(idle.env("idle"), "/workspace/note")).toBe(
        "kept\n",
      );
    } finally {
      await idle.close();
    }
  }, 120_000);

  test("a machine that died restarts on the next operation", async () => {
    const dying = new MicrosandboxWorkspaces(IMAGE, { namePrefix });

    try {
      await sh(dying.env("died"), "echo kept > /workspace/note && sync");
      await (await Sandbox.get(dying.name("died"))).kill();
      expect((await Sandbox.get(dying.name("died"))).status).not.toBe(
        "running",
      );

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

  test("the network policy decides each connection before it leaves", async () => {
    const asked: WorkspaceRequest[] = [];

    const denying = new MicrosandboxWorkspaces(IMAGE, {
      namePrefix,
      network: (request) => {
        asked.push(request);

        return false;
      },
    });

    try {
      const https = await sh(
        denying.env("denied"),
        "curl -sS -m 10 -o /dev/null https://example.com/path",
      );

      const ssh = await sh(
        denying.env("denied"),
        "timeout 10 bash -c 'head -c 4 < /dev/tcp/github.com/22'",
      );

      expect(https.exitCode).not.toBe(0);
      expect(ssh.output).not.toContain("SSH");
      expect(asked).toEqual([
        { agentId: "denied", host: "example.com", port: 443 },
      ]);
    } finally {
      await denying.close();
    }
  }, 120_000);
});
