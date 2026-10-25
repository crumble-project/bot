import assert from "node:assert/strict";
import path from "node:path";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { Sandbox, Volume } from "microsandbox";
import * as proxyModule from "./workspace-proxy";
import { Effect } from "effect";
import {
  MicrosandboxWorkspaces,
  microsandboxWorkspacesFromEnv,
} from "./microsandbox-workspaces";
import {
  WORKSPACE_PATH,
  WorkspaceInvalidAgentId,
  WorkspaceDesktopStartError,
  WorkspaceSetupError,
  WorkspaceStreamError,
  type WorkspaceRequest,
  type WorkspaceError,
  workspacePromise,
} from "./workspace";

const IMAGE = process.env["CRUMBLE_WORKSPACE_IMAGE"] ?? "";
const vmTests = process.env["CRUMBLE_VM_TESTS"] === "1" && IMAGE !== "";

// The same image under another tag, for the image change test.
const OTHER_IMAGE = process.env["CRUMBLE_WORKSPACE_IMAGE_OTHER"] ?? "";

// Sandboxes and volumes are global to the Microsandbox home, so each run gets its own names.
const namePrefix = `crumble-test-${process.pid}`;

async function sh(
  input: Effect.Effect<ExecutionEnv, WorkspaceError>,
  command: string,
) {
  const env = await workspacePromise(input);
  let output = "";

  const result = await env.exec(
    command,
    { onOutput: (text) => (output += text) },
    BACKGROUND_CONTEXT,
  );

  assert(result.ok);

  return { exitCode: result.value.exitCode, output: output.trim() };
}

async function readText(
  input: Effect.Effect<ExecutionEnv, WorkspaceError>,
  file: string,
) {
  const env = await workspacePromise(input);
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
      expect(
        Effect.runSync(workspaces.env(agentId).pipe(Effect.flip)),
      ).toBeInstanceOf(WorkspaceInvalidAgentId);
  });
});

describe("Microsandbox failures without a VM", () => {
  afterEach(() => mock.restore());

  function fakeBackend(failDisplay = false, streamExitCode = 0) {
    const cleanup = { sandbox: 0, proxy: 0 };

    const sandbox: Sandbox = Object.create(Sandbox.prototype, {
      fs: { value: () => ({ write: async () => undefined }) },
      ping: { value: async () => undefined },
      stop: {
        value: async () => {
          cleanup.sandbox += 1;
        },
      },
      exec: {
        value: async (_command: string, args: string[]) => ({
          success: !(failDisplay && args.join(" ").includes("--display")),
          stderr: () => "guest display failed",
          stdout: () => "",
        }),
      },
      execStreamWith: {
        value: async () => ({
          takeStdin: async () => ({
            write: async () => undefined,
            close: async () => undefined,
          }),
          async *[Symbol.asyncIterator]() {
            yield { kind: "exited", code: streamExitCode };
          },
        }),
      },
    });

    const builder = Sandbox.builder("fake");

    spyOn(builder, "create").mockResolvedValue(sandbox);
    spyOn(Sandbox, "builder").mockReturnValue(builder);
    spyOn(Sandbox, "get").mockRejectedValue(new Error("not found"));
    spyOn(Volume, "get").mockResolvedValue(Object.create(Volume.prototype));
    spyOn(proxyModule, "startWorkspaceProxy").mockResolvedValue({
      address: "127.0.0.1:12345",
      close: async () => {
        cleanup.proxy += 1;
      },
    });

    return cleanup;
  }

  test("volume failure identifies setup and retains the SDK cause", async () => {
    fakeBackend();
    const cause = { sdk: "volume unavailable" };
    spyOn(Volume, "get").mockRejectedValue(cause);

    const workspaces = new MicrosandboxWorkspaces("base", {
      desktopImage: "desktop",
      wantsDesktop: () => true,
    });

    const error = await Effect.runPromise(
      workspaces.openDesktop("bot").pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(WorkspaceSetupError);
    expect(error).toMatchObject({ operation: "volume", cause });
    await workspacePromise(workspaces.close());
  });

  test("display-start failure is not mislabeled as boot and closes partial resources", async () => {
    const cleanup = fakeBackend(true);

    const workspaces = new MicrosandboxWorkspaces("base", {
      desktopImage: "desktop",
      wantsDesktop: () => true,
    });

    const error = await Effect.runPromise(
      workspaces.openDesktop("bot").pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(WorkspaceDesktopStartError);
    expect(error).toMatchObject({
      operation: "display",
      cause: expect.any(Error),
    });
    expect(cleanup).toEqual({ sandbox: 1, proxy: 1 });
    await workspacePromise(workspaces.close());
  });

  test("a late nonzero socat exit is a tagged stream failure, not silent EOF", async () => {
    const cleanup = fakeBackend(false, 1);

    const workspaces = new MicrosandboxWorkspaces("base", {
      desktopImage: "desktop",
      wantsDesktop: () => true,
    });

    try {
      const stream = await workspacePromise(workspaces.openDesktop("bot"));

      await expect(
        stream.output[Symbol.asyncIterator]().next(),
      ).rejects.toBeInstanceOf(WorkspaceStreamError);
      await stream.close();
    } finally {
      await workspacePromise(workspaces.close());
    }

    expect(cleanup).toEqual({ sandbox: 1, proxy: 1 });
  });
});

describe.skipIf(!vmTests)("Microsandbox VM workspaces", () => {
  const workspaces = new MicrosandboxWorkspaces(IMAGE, { namePrefix });

  afterAll(() => workspacePromise(workspaces.close()));

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
      await use(await workspacePromise(env()));
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
    await workspacePromise(first.close());

    const second = new MicrosandboxWorkspaces(IMAGE, { namePrefix });

    try {
      expect(await readText(second.env("persist"), "/workspace/note")).toBe(
        "kept\n",
      );
    } finally {
      await workspacePromise(second.close());
    }
  }, 120_000);

  test("a machine left behind by a killed server is taken over on the next boot", async () => {
    const module = path.join(import.meta.dir, "microsandbox-workspaces.ts");

    const owner = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { MicrosandboxWorkspaces } = await import(${JSON.stringify(module)});
         const workspaces = new MicrosandboxWorkspaces(${JSON.stringify(IMAGE)}, { namePrefix: ${JSON.stringify(namePrefix)} });
         const { Effect } = await import("effect");
         const result = await (await Effect.runPromise(workspaces.env("orphaned"))).exec("echo kept > /workspace/note && echo installed > /usr/local/bin/marker && sync", {}, (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT);
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
      await workspacePromise(next.close());
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
      await workspacePromise(first.close());
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
      await workspacePromise(second.close());
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
        await workspacePromise(first.close());
      }

      const second = new MicrosandboxWorkspaces(OTHER_IMAGE, { namePrefix });

      try {
        const result = await sh(
          second.env("swap"),
          "cat /workspace/note; cat /usr/local/bin/marker 2>/dev/null || echo none",
        );

        expect(result.output).toBe("kept\nnone");
      } finally {
        await workspacePromise(second.close());
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
      await workspacePromise(idle.close());
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
      await workspacePromise(dying.close());
    }
  }, 120_000);

  test("sync is a no-op for a stopped workspace", async () => {
    await workspacePromise(workspaces.sync("never-started"));
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
      await workspacePromise(denying.close());
    }
  }, 120_000);
});
