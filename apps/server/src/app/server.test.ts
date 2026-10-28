import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Store } from "../../test/support/store";
import { agentInput, scheduleInput } from "../shared/domain";
import { ScriptRunRepository } from "../schedules/script-run-repository";
import { createTenant } from "./tenant";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentResponse,
  groupChatResponse,
  historyResponse,
  scriptRunResponse,
} from "../contract/api-responses";
import { startServer } from "./server";
import type { Workspaces } from "../workspaces/workspace";
import {
  DesktopNotConfigured,
  DesktopNotEnabled,
  DesktopStartFailed,
  WorkspaceBootFailed,
  WorkspaceStopFailed,
  WorkspaceStreamFailed,
  WorkspaceUnreachable,
  WorkspacesClosed,
  type DesktopOpenError,
} from "../workspaces/workspace-errors";

type Running = Awaited<ReturnType<typeof startServer>>;

async function signUp(running: Running, suffix = crypto.randomUUID()) {
  const response = await fetch(
    new URL("/api/auth/sign-up/email", running.server.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `Test ${suffix}`,
        email: `${suffix}@example.test`,
        password: "correct horse battery staple",
      }),
    },
  );

  expect(response.status).toBe(200);
  // SAFETY: Better Auth returns a token on successful bearer sign-up.
  const body = (await response.json()) as { token?: string };
  expect(body.token).toEqual(expect.any(String));

  return { authorization: `Bearer ${body.token}` };
}

async function signIn(running: Running, email: string) {
  const response = await fetch(
    new URL("/api/auth/sign-in/email", running.server.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery staple" }),
    },
  );

  expect(response.status).toBe(200);
  // SAFETY: Better Auth returns a token on successful bearer sign-in.
  const body = (await response.json()) as { token?: string };
  expect(body.token).toEqual(expect.any(String));

  return { authorization: `Bearer ${body.token}` };
}

/** Workspaces with only a bot desktop, which `openDesktop` opens. */
function desktopWorkspaces(openDesktop: Workspaces["openDesktop"]): Workspaces {
  return {
    desktop: true,
    env: () => {
      throw new Error("No environment in this test");
    },
    restart: () => Effect.void,
    openDesktop,
    keepAwake: () => () => {},
    startDesktop: () => Effect.void,
    sync: () => Effect.void,
  };
}

function json(headers: Record<string, string>) {
  return { ...headers, "content-type": "application/json" };
}

test.serial(
  "server owns its data directory exclusively and releases it after graceful shutdown",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-"));
    const port = 18000 + Math.floor(Math.random() * 1000);

    try {
      const running = await startServer({ dataDir, port });
      expect((await fetch(new URL("/health", running.server.url))).status).toBe(
        200,
      );
      await expect(startServer({ dataDir, port })).rejects.toThrow(
        "already being held",
      );
      await running.close();
      const reopened = await startServer({ dataDir, port });
      await reopened.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test.serial("accepts requests from the localhost origin", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-origin-"));
  const port = 19000 + Math.floor(Math.random() * 1000);

  try {
    const running = await startServer({ dataDir, port });

    const signUpFrom = (origin: string) =>
      fetch(new URL("/api/auth/sign-up/email", running.server.url), {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          name: "Test",
          email: `${crypto.randomUUID()}@example.test`,
          password: "correct horse battery staple",
        }),
      });

    expect((await signUpFrom(`http://localhost:${port}`)).status).toBe(200);
    expect((await signUpFrom(`http://127.0.0.1:${port}`)).status).toBe(200);
    expect((await signUpFrom("https://evil.example")).status).toBe(403);
    await running.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test.serial("offers passkey registration on localhost", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-passkey-"));
  const port = 19000 + Math.floor(Math.random() * 1000);

  try {
    const running = await startServer({ dataDir, port });
    const headers = await signUp(running);

    const response = await fetch(
      new URL(
        "/api/auth/passkey/generate-register-options",
        running.server.url,
      ),
      { headers },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rp: { id: "localhost", name: "Crumble" },
    });
    await running.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test.serial("loads the workspace skills directory by default", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-skills-"));
  const port = 19000 + Math.floor(Math.random() * 1000);

  try {
    const running = await startServer({ dataDir, port });
    const headers = await signUp(running);

    const response = await fetch(new URL("/v1/skills", running.server.url), {
      headers,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "common:tasks/SKILL.md",
          source: "bundled",
          name: "tasks",
        }),
        expect.objectContaining({
          id: "common:bot-messaging/SKILL.md",
          source: "bundled",
          name: "bot-messaging",
        }),
      ]),
    );
    await running.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test.serial(
  "failed listener startup releases the push worker and data lock",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-push-startup-"));
    let unexpected: Running | undefined;

    try {
      let failure: unknown;

      try {
        unexpected = await startServer({ dataDir, port: 65536 });
      } catch (error) {
        failure = error;
      }

      await unexpected?.close();
      expect(failure).toBeDefined();
      const running = await startServer({ dataDir, port: 0 });
      await running.close();
    } finally {
      await unexpected?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test.serial("serves group chats and keeps them across restarts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-groups-"));
  const port = 20000 + Math.floor(Math.random() * 1000);

  try {
    const running = await startServer({ dataDir, port });
    const headers = await signUp(running);
    const memberIds: string[] = [];

    for (const name of ["Planner", "Researcher"]) {
      const response = await fetch(new URL("/v1/agents", running.server.url), {
        method: "POST",
        headers: json(headers),
        body: JSON.stringify({ name }),
      });

      expect(response.status).toBe(201);
      memberIds.push(agentResponse.parse(await response.json()).id);
    }

    const created = await fetch(
      new URL("/v1/group-chats", running.server.url),
      {
        method: "POST",
        headers: json(headers),
        body: JSON.stringify({ name: "Trip", memberIds }),
      },
    );

    expect(created.status).toBe(201);
    const group = groupChatResponse.parse(await created.json());

    const message = await fetch(
      new URL(`/v1/group-chats/${group.id}/messages`, running.server.url),
      {
        method: "POST",
        headers: json(headers),
        body: JSON.stringify({
          content: "Hello",
          requestId: crypto.randomUUID(),
        }),
      },
    );

    expect(message.status).toBe(201);
    await running.close();
    const reopened = await startServer({ dataDir, port });

    const history = await fetch(
      new URL(`/v1/group-chats/${group.id}/history`, reopened.server.url),
      { headers },
    );

    expect(historyResponse.parse(await history.json()).messages).toMatchObject([
      { content: "Hello" },
    ]);
    await reopened.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test.serial(
  "a desktop viewer link opens without the owner's session",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-viewer-"));
    const port = 20000 + Math.floor(Math.random() * 1000);

    // A bot desktop that greets like a VNC server and then waits.
    const workspaces = desktopWorkspaces(() =>
      Effect.succeed({
        write: async () => {},
        output: (async function* () {
          yield new TextEncoder().encode("RFB 003.008\n");
          await new Promise(() => {});
        })(),
        close: async () => {},
      }),
    );

    try {
      const running = await startServer({
        dataDir,
        port,
        workspaces: () => Effect.succeed(workspaces),
      });

      const headers = await signUp(running);

      const agent = agentResponse.parse(
        await (
          await fetch(new URL("/v1/agents", running.server.url), {
            method: "POST",
            headers: json(headers),
            body: JSON.stringify({ name: "Viewer", tools: ["desktop"] }),
          })
        ).json(),
      );

      const viewer = await fetch(
        new URL(`/v1/agents/${agent.id}/desktop/viewer`, running.server.url),
        { method: "POST", headers },
      );

      // SAFETY: The route returns the DesktopViewer schema.
      const link = ((await viewer.json()) as { path: string }).path;
      const [owner, secret] = link.split("/").at(-1)!.split(".");

      // A web view sends neither the session cookie nor a bearer token.
      expect((await fetch(new URL(link, running.server.url))).status).toBe(200);
      expect(
        (
          await fetch(
            new URL("/desktop-viewer/novnc/core/rfb.js", running.server.url),
          )
        ).status,
      ).toBe(200);

      // The account in a ticket only routes it; the secret must be one that account issued.
      expect(
        (
          await fetch(
            new URL(`/desktop-viewer/${owner}.forged`, running.server.url),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(
            new URL(`/desktop-viewer/nobody.${secret}`, running.server.url),
          )
        ).status,
      ).toBe(401);

      const greeting = await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(
          new URL(
            `${link}/websockify`,
            running.server.url.href.replace("http", "ws"),
          ),
        );

        socket.binaryType = "arraybuffer";
        socket.addEventListener("message", (event) => {
          // SAFETY: binaryType is arraybuffer, so binary messages arrive as ArrayBuffer.
          resolve(new TextDecoder().decode(event.data as ArrayBuffer));
          socket.close();
        });
        socket.addEventListener("error", () =>
          reject(new Error("WebSocket error")),
        );
      });

      expect(greeting).toBe("RFB 003.008\n");
      await running.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

// Each failure's message and cause carry a secret, as guest output might: only the log may show them.
const SECRET = "token=secret-123";

const failure = (tag: string) => ({
  message: `${tag} failed (${SECRET})`,
  cause: `${tag} cause (${SECRET})`,
});

const desktopFailures: Array<{
  error: DesktopOpenError;
  reason: string;
}> = [
  {
    error: new DesktopNotConfigured({
      message: failure("DesktopNotConfigured").message,
    }),
    reason: "This server has no bot desktop image",
  },
  {
    error: new DesktopNotEnabled({
      message: failure("DesktopNotEnabled").message,
    }),
    reason: "This bot needs the desktop tool for its bot desktop",
  },
  {
    error: new WorkspaceBootFailed(failure("WorkspaceBootFailed")),
    reason: "The bot's workspace did not start",
  },
  {
    error: new DesktopStartFailed(failure("DesktopStartFailed")),
    reason: "The bot desktop did not start",
  },
  {
    error: new WorkspaceStreamFailed(failure("WorkspaceStreamFailed")),
    reason: "The bot desktop's socat relay did not start",
  },
  {
    error: new WorkspaceUnreachable(failure("WorkspaceUnreachable")),
    reason: "The bot's workspace is unreachable",
  },
  {
    error: new WorkspacesClosed({
      message: failure("WorkspacesClosed").message,
    }),
    reason: "The server is shutting down",
  },
  {
    error: new WorkspaceStopFailed(failure("WorkspaceStopFailed")),
    reason: "The bot's previous machine did not stop",
  },
];

test.serial(
  "a bot desktop that fails to open is logged and named in the viewer's close reason",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-viewer-fail-"));
    const logged: string[] = [];

    const spies = (["log", "warn", "error"] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args) => {
        logged.push(args.map(String).join(" "));
      }),
    );

    let opening: Effect.Effect<never, DesktopOpenError> = Effect.never;

    const workspaces: Workspaces = {
      ...desktopWorkspaces(() => opening),
      startDesktop: () => opening,
    };

    try {
      const running = await startServer({
        dataDir,
        port: 0,
        workspaces: () => Effect.succeed(workspaces),
      });

      const headers = await signUp(running);

      const agent = agentResponse.parse(
        await (
          await fetch(new URL("/v1/agents", running.server.url), {
            method: "POST",
            headers: json(headers),
            body: JSON.stringify({ name: "Viewer", tools: ["desktop"] }),
          })
        ).json(),
      );

      // Each viewer link opens one connection; the server boots the bot desktop when it issues one.
      const close = async () => {
        const viewer = await fetch(
          new URL(`/v1/agents/${agent.id}/desktop/viewer`, running.server.url),
          { method: "POST", headers },
        );

        // SAFETY: The route returns the DesktopViewer schema.
        const link = ((await viewer.json()) as { path: string }).path;

        return new Promise<CloseEvent>((resolve) => {
          const socket = new WebSocket(
            new URL(
              `${link}/websockify`,
              running.server.url.href.replace("http", "ws"),
            ),
          );

          socket.addEventListener("close", resolve);
        });
      };

      for (const { error, reason } of desktopFailures) {
        opening = Effect.fail(error);
        logged.length = 0;

        const closed = await close();

        expect(closed.code).toBe(1011);
        expect(closed.reason).toBe(reason);
        expect(closed.reason).not.toContain(SECRET);
        expect(Buffer.byteLength(closed.reason)).toBeLessThanOrEqual(123);

        const log = logged.join("\n");

        expect(log).toContain("Opening a bot desktop failed");
        expect(log).toContain("Booting a bot desktop failed");
        expect(log).toContain(error.message);
      }

      // A defect has no name for the owner, but the log still has it.
      opening = Effect.die(new Error(`The relay crashed (${SECRET})`));
      logged.length = 0;

      const closed = await close();

      expect(closed.code).toBe(1011);
      expect(closed.reason).toBe("The bot desktop is unavailable");
      expect(logged.join("\n")).toContain("The relay crashed");
      await running.close();
    } finally {
      for (const spy of spies) spy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test.serial(
  "an account recovers script runs and dispatches due scripts into the bot chat",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-account-scripts-"));
    let tenant: Awaited<ReturnType<typeof createTenant>> | undefined;

    try {
      const store = new Store(dataDir);
      let agentId: string;
      let scheduleId: string;

      try {
        const agent = store.createAgent(
          agentInput.parse({ name: "Runner", tools: ["coding"] }),
        );

        const schedule = store.createSchedule(
          scheduleInput.parse({
            agentId: agent.id,
            name: "Due script",
            kind: "script",
            command: "printf 'account script output'",
            runAt: "2020-01-01T00:00:00.000Z",
          }),
        );

        agentId = agent.id;
        scheduleId = schedule.id;
        store.run(
          ScriptRunRepository.use((runs) =>
            runs.create({
              id: "leftover-run",
              scheduleId,
              agentId,
              command: schedule.command!,
              status: "running",
              exitCode: null,
              output: "",
              droppedBytes: 0,
              error: null,
              startedAt: new Date().toISOString(),
              finishedAt: null,
            }),
          ),
        );
      } finally {
        store.close();
      }

      const workspaces: Workspaces = {
        ...desktopWorkspaces(() =>
          Effect.fail(new DesktopNotConfigured({ message: "No desktop" })),
        ),
        desktop: false,
        env: (_agentId, shellEnv = {}) => {
          const env = new NodeExecutionEnv({ cwd: dataDir, shellEnv });
          const exec = env.exec.bind(env);
          env.exec = (command, options, context) =>
            exec(command, { ...options, cwd: dataDir }, context);

          return env;
        },
      };

      tenant = await createTenant({
        dataDir,
        tenantId: "script-test",
        workspaces: Effect.succeed(workspaces),
      });
      const headers = { authorization: `Bearer ${tenant.token}` };

      const runs = async () => {
        const response = await tenant!.app.request(
          `/v1/schedules/${scheduleId}/runs`,
          { headers },
        );

        expect(response.status).toBe(200);

        return scriptRunResponse.array().parse(await response.json());
      };

      expect(
        (await runs()).find((run) => run.id === "leftover-run"),
      ).toMatchObject({
        status: "interrupted",
        finishedAt: expect.any(String),
      });

      let messages: ReturnType<typeof historyResponse.parse>["messages"] = [];

      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await tenant.app.request(
          `/v1/agents/${agentId}/chat/history`,
          {
            headers,
          },
        );

        expect(response.status).toBe(200);
        messages = historyResponse.parse(await response.json()).messages;

        if (messages.some((message) => message.origin?.kind === "script"))
          break;
        await Bun.sleep(20);
      }

      expect(await runs()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scheduleId,
            agentId,
            status: "succeeded",
            exitCode: 0,
            output: "account script output",
          }),
        ]),
      );
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining("account script output"),
            origin: { kind: "script", name: "Due script" },
          }),
        ]),
      );
    } finally {
      await tenant?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

export { signIn, signUp };
