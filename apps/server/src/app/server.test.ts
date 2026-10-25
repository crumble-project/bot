import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentResponse,
  groupChatResponse,
  historyResponse,
} from "../contract/api-responses";
import { startServer } from "./server";
import type { Workspaces } from "../workspaces/workspace";
import { DesktopStartFailed } from "../workspaces/workspace-errors";

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
    keepAwake: () => Effect.succeed(Effect.void),
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

test.serial(
  "a bot desktop that fails to open is logged and named in the viewer's close reason",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-viewer-fail-"));
    const logged: unknown[][] = [];

    const log = spyOn(console, "log").mockImplementation((...args) => {
      logged.push(args);
    });

    const error = spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args);
    });

    const workspaces = desktopWorkspaces(() =>
      Effect.fail(
        new DesktopStartFailed({
          message:
            "The bot desktop did not start: /opt/crumble/desktop-start.sh failed: Xvnc died",
          cause: "Xvnc died",
        }),
      ),
    );

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

      const viewer = await fetch(
        new URL(`/v1/agents/${agent.id}/desktop/viewer`, running.server.url),
        { method: "POST", headers },
      );

      // SAFETY: The route returns the DesktopViewer schema.
      const link = ((await viewer.json()) as { path: string }).path;

      const closed = await new Promise<CloseEvent>((resolve) => {
        const socket = new WebSocket(
          new URL(
            `${link}/websockify`,
            running.server.url.href.replace("http", "ws"),
          ),
        );

        socket.addEventListener("close", resolve);
      });

      expect(closed.code).toBe(1011);
      expect(closed.reason).toBe("The bot desktop did not start");
      expect(
        logged.some((args) =>
          args.some((arg) => String(arg).includes("Xvnc died")),
        ),
      ).toBe(true);
      await running.close();
    } finally {
      log.mockRestore();
      error.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

export { signIn, signUp };
