import { expect, setDefaultTimeout, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { error } from "../contract/route";
import { startServer } from "./server";
import type { Workspaces } from "../workspaces/workspace";

// Password hashing alone can pass the default 5 seconds on a loaded machine.
setDefaultTimeout(30_000);

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
          token: { value: "private-mcp-token" },
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
          body: JSON.stringify({ value: "first-provider-secret" }),
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
      const reader = events.body!.getReader();
      const initial = await reader.read();
      expect(new TextDecoder().decode(initial.value)).toContain(
        "event: snapshot",
      );
      await reader.cancel();
    } finally {
      await running?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test.serial("deleting a bot or an account removes the workspaces", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "crumble-workspace-removal-"));
  const removed: string[] = [];
  let running: Awaited<ReturnType<typeof startServer>> | undefined;

  const workspaces = {
    desktop: false,
    env: () => {
      throw new Error("unused");
    },
    restart: () => Effect.void,
    remove: (agentId: string) =>
      Effect.sync(() => {
        removed.push(agentId);
      }),
    sync: () => Effect.void,
    keepAwake: () => () => {},
    outdated: () => [],
    running: () => false,
    desktopRunning: () => false,
    startDesktop: () => Effect.void,
    openDesktop: () => Effect.die("unused"),
  } satisfies Workspaces;

  try {
    running = await startServer({
      dataDir,
      port: 0,
      workspaces: () => Effect.succeed(workspaces),
    });

    const admin = await signUp(running, `admin-${crypto.randomUUID()}`);
    const user = await signUp(running, `user-${crypto.randomUUID()}`);
    const url = (path: string) => new URL(path, running!.server.url);

    const create = async (name: string) => {
      const created = await fetch(url("/v1/agents"), {
        method: "POST",
        headers: json(user),
        body: JSON.stringify({ name }),
      });

      // SAFETY: The agent route returns the documented agent object.
      return ((await created.json()) as { id: string }).id;
    };

    const deleted = await create("Deleted");
    const kept = await create("Kept");

    const gone = await fetch(url(`/v1/agents/${deleted}`), {
      method: "DELETE",
      headers: user,
    });

    expect(gone.status).toBe(204);
    expect(removed).toEqual([deleted]);

    // SAFETY: The admin route returns the documented user list.
    const { users } = (await (
      await fetch(url("/v1/admin/users"), { headers: admin })
    ).json()) as { users: { id: string }[] };

    const account = await fetch(url(`/v1/admin/users/${users[1]!.id}`), {
      method: "DELETE",
      headers: admin,
    });

    expect(account.status).toBe(204);
    expect(removed).toEqual([deleted, kept]);
  } finally {
    await running?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

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
        remove: () => Effect.void,
        sync: () => Effect.void,
        keepAwake: () => () => {},
        outdated: () => [],
        running: () => false,
        desktopRunning: () => false,
        startDesktop: () => Effect.void,
        openDesktop: () =>
          Effect.succeed({
            write: async () => undefined,
            output: (async function* () {
              yield new TextEncoder().encode("RFB 003.008\n");
            })(),
            close: async () => undefined,
          }),
      } satisfies Workspaces;

      running = await startServer({
        dataDir,
        port: 0,
        workspaces: () => Effect.succeed(workspaces),
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
        socket!.addEventListener("open", () => resolve());
        socket!.addEventListener("error", () =>
          reject(new Error("viewer websocket error")),
        );
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

      const agents = await fetch(new URL("/v1/agents", reopened.server.url), {
        headers: fresh,
      });

      expect(agents.status).toBe(200);
      expect(await agents.json()).toMatchObject([{ name: "Durable" }]);
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

      expect(unsafe.status).toBe(403);
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
      const cookie = signup.headers.get("set-cookie")?.split(";")[0];

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
  "admin routes answer a bad request with the contract's error and cap body size",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-admin-errors-"));
    let running: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      running = await startServer({ dataDir, port: 0 });
      const admin = await signUp(running, `admin-${crypto.randomUUID()}`);

      const patch = (body: string) =>
        fetch(new URL("/v1/admin/settings", running!.server.url), {
          method: "PATCH",
          headers: json(admin),
          body,
        });

      const invalid = await patch(JSON.stringify({ workspaceCpus: 0 }));

      expect(invalid.status).toBe(400);
      expect(error.parse(await invalid.json())).toMatchObject({
        error: "Invalid request",
        details: [expect.objectContaining({ path: ["workspaceCpus"] })],
      });

      const malformed = await patch("{");

      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: "Invalid JSON" });

      const oversized = await patch(
        JSON.stringify({ codingImage: "a".repeat(1024 * 1024) }),
      );

      expect(oversized.status).toBe(413);
    } finally {
      await running?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test.serial(
  "only admins reach the admin API, and the plugin's own admin routes are closed",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-admin-"));
    let running: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      running = await startServer({ dataDir, port: 0 });
      const admin = await signUp(running, `admin-${crypto.randomUUID()}`);
      const user = await signUp(running, `user-${crypto.randomUUID()}`);
      const url = (path: string) => new URL(path, running!.server.url);

      for (const [method, path] of [
        ["GET", "/v1/admin/users"],
        ["POST", "/v1/admin/invites"],
        ["PATCH", "/v1/admin/settings"],
      ] as const)
        expect(
          (
            await fetch(url(path), {
              method,
              headers: json(user),
              body: method === "GET" ? null : "{}",
            })
          ).status,
        ).toBe(403);

      expect(
        (await fetch(url("/api/auth/admin/list-users"), { headers: admin }))
          .status,
      ).toBe(404);

      const listed = await fetch(url("/v1/admin/users"), { headers: admin });

      expect(listed.status).toBe(200);

      // SAFETY: The route returns the documented user list.
      const { users } = (await listed.json()) as {
        users: { id: string; role: string }[];
      };

      expect(users.map((entry) => entry.role)).toEqual(["admin", "user"]);

      const lastAdmin = await fetch(url(`/v1/admin/users/${users[0]!.id}`), {
        method: "PATCH",
        headers: json(admin),
        body: JSON.stringify({ role: "user" }),
      });

      expect(lastAdmin.status).toBe(409);

      const removed = await fetch(url(`/v1/admin/users/${users[1]!.id}`), {
        method: "DELETE",
        headers: admin,
      });

      expect(removed.status).toBe(204);
      expect((await fetch(url("/v1/agents"), { headers: user })).status).toBe(
        401,
      );
    } finally {
      await running?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
