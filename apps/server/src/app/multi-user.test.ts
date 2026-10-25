import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server";
import { Effect } from "effect";
import {
  BotDesktopStartFailed,
  type WorkspaceService,
} from "../workspaces/workspace";

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
      body: JSON.stringify({
        email,
        password: "correct horse battery staple",
      }),
    },
  );

  expect(response.status).toBe(200);
  // SAFETY: Better Auth returns a token on successful bearer sign-in.
  const body = (await response.json()) as { token?: string };
  expect(body.token).toEqual(expect.any(String));

  return { authorization: `Bearer ${body.token}` };
}

function json(headers: Record<string, string>) {
  return { ...headers, "content-type": "application/json" };
}

test.serial(
  "users have isolated bots, memories, provider credentials, and SSE streams",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-multi-user-"));
    let running: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      running = await startServer({ dataDir, port: 0 });
      const first = await signUp(running, `first-${crypto.randomUUID()}`);
      const second = await signUp(running, `second-${crypto.randomUUID()}`);

      const created = await fetch(new URL("/v1/agents", running.server.url), {
        method: "POST",
        headers: json(first),
        body: JSON.stringify({ name: "Private bot" }),
      });

      expect(created.status).toBe(201);
      // SAFETY: The agent route returns the documented agent object.
      const agent = (await created.json()) as { id: string };

      expect(
        (
          await fetch(new URL("/v1/agents", running.server.url), {
            headers: second,
          })
        ).status,
      ).toBe(200);
      expect(
        await (
          await fetch(new URL("/v1/agents", running.server.url), {
            headers: second,
          })
        ).json(),
      ).toEqual([]);
      expect(
        (
          await fetch(new URL(`/v1/agents/${agent.id}`, running.server.url), {
            headers: second,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(new URL(`/v1/agents/${agent.id}`, running.server.url), {
            method: "PATCH",
            headers: json(second),
            body: JSON.stringify({ name: "hijacked" }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(new URL(`/v1/agents/${agent.id}`, running.server.url), {
            method: "DELETE",
            headers: second,
          })
        ).status,
      ).toBe(404);

      const memory = await fetch(new URL("/v1/memories", running.server.url), {
        method: "POST",
        headers: json(first),
        body: JSON.stringify({ content: "first secret" }),
      });

      expect(memory.status).toBe(201);
      // SAFETY: The memory route returns the documented memory object.
      const memoryId = ((await memory.json()) as { id: string }).id;
      expect(
        (
          await fetch(new URL(`/v1/memories/${memoryId}`, running.server.url), {
            headers: second,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(new URL(`/v1/memories/${memoryId}`, running.server.url), {
            method: "PATCH",
            headers: json(second),
            body: JSON.stringify({ content: "hijacked" }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(new URL(`/v1/memories/${memoryId}`, running.server.url), {
            method: "DELETE",
            headers: second,
          })
        ).status,
      ).toBe(404);

      const skill = await fetch(
        new URL(`/v1/agents/${agent.id}/skills`, running.server.url),
        {
          method: "POST",
          headers: json(first),
          body: JSON.stringify({
            name: "private-skill",
            description: "private",
            instructions: "Keep this private",
          }),
        },
      );

      expect(skill.status).toBe(201);
      expect(
        (
          await fetch(
            new URL(`/v1/agents/${agent.id}/skills`, running.server.url),
            {
              headers: second,
            },
          )
        ).status,
      ).toBe(404);

      const mcp = await fetch(new URL("/v1/mcp-servers", running.server.url), {
        method: "POST",
        headers: json(first),
        body: JSON.stringify({
          name: "private-mcp",
          url: "https://mcp.example.test",
          token: "private-mcp-token",
        }),
      });

      expect(mcp.status).toBe(201);
      expect(
        await (
          await fetch(new URL("/v1/mcp-servers", running.server.url), {
            headers: second,
          })
        ).json(),
      ).toEqual([]);

      const schedule = await fetch(
        new URL("/v1/schedules", running.server.url),
        {
          method: "POST",
          headers: json(first),
          body: JSON.stringify({
            agentId: agent.id,
            name: "private schedule",
            prompt: "private",
            cron: "0 0 * * *",
            timezone: "UTC",
            enabled: false,
          }),
        },
      );

      expect(schedule.status).toBe(201);
      expect(
        await (
          await fetch(new URL("/v1/schedules", running.server.url), {
            headers: second,
          })
        ).json(),
      ).toEqual([]);

      const configured = await fetch(
        new URL("/v1/providers/openai", running.server.url),
        {
          method: "PUT",
          headers: json(first),
          body: JSON.stringify({ apiKey: "first-provider-secret" }),
        },
      );

      expect(configured.status).toBe(200);

      // SAFETY: The providers route returns the documented provider list.
      const providers = (await (
        await fetch(new URL("/v1/providers", running.server.url), {
          headers: second,
        })
      ).json()) as Array<{ provider: string; configured: boolean }>;

      expect(
        providers.find((provider) => provider.provider === "openai")
          ?.configured,
      ).toBe(false);

      const events = await fetch(
        new URL(`/v1/agents/${agent.id}/events`, running.server.url),
        { headers: json(first) },
      );

      expect(events.status).toBe(200);
      expect(events.headers.get("content-type")).toContain("text/event-stream");
      const reader = events.body?.getReader();
      expect(reader).toBeDefined();
      const initial = await reader!.read();
      expect(new TextDecoder().decode(initial.value)).toContain(
        "event: snapshot",
      );
      await reader!.cancel();
    } finally {
      await running?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test.serial(
  "desktop viewer tickets upgrade an authenticated WebSocket",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-viewer-auth-"));
    let running: Awaited<ReturnType<typeof startServer>> | undefined;
    let socket: WebSocket | undefined;

    try {
      const workspaces = {
        desktop: true,
        env: () => {
          throw new Error("unused in viewer test");
        },
        restart: () => Effect.void,
        sync: () => Effect.void,
        close: Effect.void,
        keepAwake: () => () => undefined,
        startDesktop: () => Effect.void,
        openDesktop: () =>
          Effect.succeed({
            write: async () => undefined,
            output: (async function* () {
              yield new TextEncoder().encode("RFB 003.008\n");
            })(),
            close: async () => undefined,
          }),
      } satisfies WorkspaceService;

      running = await startServer({
        dataDir,
        port: 0,
        workspaces: () => workspaces,
      });
      const owner = await signUp(running, `viewer-${crypto.randomUUID()}`);

      const foreign = await signUp(
        running,
        `foreign-viewer-${crypto.randomUUID()}`,
      );

      const agent = await fetch(new URL("/v1/agents", running.server.url), {
        method: "POST",
        headers: json(owner),
        body: JSON.stringify({ name: "Desktop", tools: ["desktop"] }),
      });

      expect(agent.status).toBe(201);
      // SAFETY: The agent route returns the documented agent object.
      const agentId = ((await agent.json()) as { id: string }).id;

      const ticketResponse = await fetch(
        new URL(`/v1/agents/${agentId}/desktop/viewer`, running.server.url),
        { method: "POST", headers: owner },
      );

      expect(ticketResponse.status).toBe(201);

      // SAFETY: The viewer route returns the documented ticket path.
      const ticketPath = ((await ticketResponse.json()) as { path: string })
        .path;

      expect(
        (
          await fetch(new URL(ticketPath, running.server.url), {
            headers: foreign,
          })
        ).status,
      ).toBe(404);

      const ownTicket = await fetch(new URL(ticketPath, running.server.url), {
        headers: owner,
      });

      expect(ownTicket.status).toBe(200);
      const wsUrl = new URL(`${ticketPath}/websockify`, running.server.url);
      wsUrl.protocol = "ws:";

      // SAFETY: Bun's WebSocket constructor accepts request headers in its second argument.
      const WebSocketWithHeaders = WebSocket as typeof WebSocket &
        (new (
          url: string,
          options: { headers: Record<string, string> },
        ) => WebSocket);

      socket = new WebSocketWithHeaders(wsUrl.toString(), { headers: owner });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("viewer websocket timeout")),
          2000,
        );

        socket!.addEventListener("open", () => {
          clearTimeout(timer);
          resolve();
        });
        socket!.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("viewer websocket error"));
        });
      });
    } finally {
      socket?.close();
      await running?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test.serial(
  "logout revokes bearer tokens and sessions survive a restart",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-auth-restart-"));
    const suffix = crypto.randomUUID();
    const email = `${suffix}@example.test`;
    let running: Awaited<ReturnType<typeof startServer>> | undefined;
    let reopened: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      running = await startServer({ dataDir, port: 0 });
      const token = await signUp(running, suffix);

      const created = await fetch(new URL("/v1/agents", running.server.url), {
        method: "POST",
        headers: json(token),
        body: JSON.stringify({ name: "Durable" }),
      });

      expect(created.status).toBe(201);

      const signedOut = await fetch(
        new URL("/api/auth/sign-out", running.server.url),
        {
          method: "POST",
          headers: token,
        },
      );

      expect(signedOut.status).toBe(200);
      expect(
        (
          await fetch(new URL("/v1/agents", running.server.url), {
            headers: token,
          })
        ).status,
      ).toBe(401);
      await running.close();
      running = undefined;

      reopened = await startServer({ dataDir, port: 0 });
      const fresh = await signIn(reopened, email);
      expect(
        (
          await fetch(new URL("/v1/agents", reopened.server.url), {
            headers: fresh,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(new URL("/v1/agents", reopened.server.url), {
            headers: fresh,
          })
        ).json(),
      ).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "Durable" })]),
      );
    } finally {
      await running?.close();
      await reopened?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test.serial(
  "legacy server tokens and unsafe auth origins are rejected",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-auth-boundary-"));
    let running: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      running = await startServer({ dataDir, port: 0 });
      expect(
        (
          await fetch(new URL("/v1/agents", running.server.url), {
            headers: { authorization: `Bearer ${"x".repeat(40)}` },
          })
        ).status,
      ).toBe(401);

      const unsafe = await fetch(
        new URL("/api/auth/sign-up/email", running.server.url),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://evil.example.test",
          },
          body: JSON.stringify({
            name: "Unsafe",
            email: `unsafe-${crypto.randomUUID()}@example.test`,
            password: "correct horse battery staple",
          }),
        },
      );

      expect([400, 403]).toContain(unsafe.status);
    } finally {
      await running?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test.serial(
  "cookie sessions enforce origin checks for state-changing requests",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-cookie-auth-"));
    let running: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      running = await startServer({ dataDir, port: 0 });
      const origin = new URL(running.server.url).origin;

      const signup = await fetch(
        new URL("/api/auth/sign-up/email", running.server.url),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Cookie user",
            email: `cookie-${crypto.randomUUID()}@example.test`,
            password: "correct horse battery staple",
          }),
        },
      );

      expect(signup.status).toBe(200);
      const setCookie = signup.headers.get("set-cookie");
      expect(setCookie).toEqual(expect.any(String));
      const cookie = setCookie?.split(";")[0];

      if (!cookie) throw new Error("Signup must return a session cookie");
      expect(
        (
          await fetch(new URL("/v1/agents", running.server.url), {
            headers: { cookie },
          })
        ).status,
      ).toBe(200);

      for (const invalidOrigin of [undefined, "https://evil.example.test"]) {
        const headers = new Headers({
          cookie,
          "content-type": "application/json",
        });

        if (invalidOrigin) headers.set("origin", invalidOrigin);

        expect(
          (
            await fetch(new URL("/v1/agents", running.server.url), {
              method: "POST",
              headers,
              body: JSON.stringify({ name: "blocked" }),
            })
          ).status,
        ).toBe(403);
      }

      expect(
        (
          await fetch(new URL("/v1/agents", running.server.url), {
            method: "POST",
            headers: { cookie, origin, "content-type": "application/json" },
            body: JSON.stringify({ name: "cookie bot" }),
          })
        ).status,
      ).toBe(201);

      const signedOut = await fetch(
        new URL("/api/auth/sign-out", running.server.url),
        { method: "POST", headers: { cookie, origin } },
      );

      expect(signedOut.status).toBe(200);
      expect(
        (
          await fetch(new URL("/v1/agents", running.server.url), {
            headers: { cookie },
          })
        ).status,
      ).toBe(401);
    } finally {
      await running?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test.serial(
  "a failed desktop open is logged and closes the viewer with an actionable reason",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-viewer-failure-"));
    let running: Awaited<ReturnType<typeof startServer>> | undefined;

    const failure = new BotDesktopStartFailed({
      agentId: "desktop",
      message: "The bot desktop did not start: desktop-start.sh exited 1",
      cause: new Error("desktop-start.sh exited 1"),
    });

    const workspaces: WorkspaceService = {
      desktop: true,
      env: () => {
        throw new Error("unused in viewer failure test");
      },
      restart: () => Effect.void,
      sync: () => Effect.void,
      close: Effect.void,
      keepAwake: () => () => undefined,
      startDesktop: () => Effect.void,
      openDesktop: () => Effect.fail(failure),
    };

    try {
      running = await startServer({
        dataDir,
        port: 0,
        workspaces: () => workspaces,
      });
      const owner = await signUp(running, `failure-${crypto.randomUUID()}`);

      const agent = await fetch(new URL("/v1/agents", running.server.url), {
        method: "POST",
        headers: json(owner),
        body: JSON.stringify({ name: "Desktop", tools: ["desktop"] }),
      });

      expect(agent.status).toBe(201);
      // SAFETY: The agent route returns the documented agent object.
      const agentId = ((await agent.json()) as { id: string }).id;

      const viewer = await fetch(
        new URL(`/v1/agents/${agentId}/desktop/viewer`, running.server.url),
        { method: "POST", headers: owner },
      );

      expect(viewer.status).toBe(201);
      // SAFETY: The viewer route returns the documented ticket path.
      const path = ((await viewer.json()) as { path: string }).path;
      const socketUrl = new URL(`${path}/websockify`, running.server.url);

      socketUrl.protocol = "ws:";

      const closed = await new Promise<CloseEvent>((resolve, reject) => {
        const socket = new WebSocket(socketUrl);

        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("viewer websocket timeout"));
        }, 5000);

        socket.addEventListener("close", (event) => {
          clearTimeout(timer);
          resolve(event);
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("viewer websocket error"));
        });
      });

      expect(closed.code).toBe(1011);
      expect(closed.reason).toBe(
        "The bot desktop failed to start; check the server log",
      );
    } finally {
      await running?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
