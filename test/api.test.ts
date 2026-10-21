import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store";
import { CrumbleService } from "../src/service";
import { Scheduler } from "../src/scheduler";
import { createAPI } from "../src/api";
import { memoryResponse } from "../src/api-responses";

const token = "t".repeat(40);

type RuntimeAgent = { id: string };

type SnapshotOptions = { limit?: number };

type EventCallback = (event: { type: string }) => void;

type RequestBody = {
  content?: string;
  requestId?: string;
  attachments?: { name: string; mimeType: string; data: string }[];
};

const agentInput = (name: string, enabled = true) => ({
  name,
  enabled,
  avatar: "sparkles",
  description: "",
  instructions: "help",
  provider: "openai" as const,
  model: "gpt-4.1",
  tools: [],
  skills: [],
  mcpServers: [],
});

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join("/tmp", "bot-api-"));
  dirs.push(dir);
  let sequence = 0;

  const runtime: any = {
    openChat: async (agent: { id: string }) => `${agent.id}:${++sequence}`,
    submit: async (
      _a: RuntimeAgent,
      _c: string,
      _text: string,
      requestId: string,
    ) => `submission-${requestId}`,
    wait: async () => ({ status: "done" }),
    snapshot: async (_a: RuntimeAgent, conversationId: string) => ({
      conversationId,
      messages: [],
      live: null,
      status: "idle",
      updatedAt: Date.now(),
    }),
    abort: async () => {},
    deleteAgent: async () => {},
    history: async () => ({ messages: [] }),
    desktopJobs: async () => [],
  };

  const store = new Store(dir);
  const service = new CrumbleService(store, runtime);

  const scheduler = new Scheduler(store, (a, p, r, s) =>
    service.dispatch(a, p, r, s),
  );

  return { app: createAPI(service, scheduler, token), store, runtime };
}

const req = (app: any, path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });

describe("HTTP API", () => {
  test("reports whether the server can run coding jobs", async () => {
    const { app, store, runtime } = setup();
    const service = new CrumbleService(store, runtime);

    const scheduler = new Scheduler(store, (a, p, r, s) =>
      service.dispatch(a, p, r, s),
    );

    const withCoding = createAPI(service, scheduler, token, undefined, {
      coding: true,
    });

    const withDesktop = createAPI(service, scheduler, token, undefined, {
      coding: true,
      desktop: true,
    });

    const without = await req(app, "/v1/capabilities");
    expect(await without.json()).toEqual({ coding: false, desktop: false });
    expect(await (await req(withCoding, "/v1/capabilities")).json()).toEqual({
      coding: true,
      desktop: false,
    });
    expect(await (await req(withDesktop, "/v1/capabilities")).json()).toEqual({
      coding: true,
      desktop: true,
    });
  });

  test("agents keep a desktop job model", async () => {
    const { app } = setup();

    const created = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Desk",
        desktopModel: { provider: "opencode-go", model: "gpt-6-luna" },
      }),
    });

    expect((await created.json()).desktopModel).toEqual({
      provider: "opencode-go",
      model: "gpt-6-luna",
    });
  });

  test("gaining or losing the desktop tool restarts the bot's workspace", async () => {
    const { store, runtime } = setup();
    const service = new CrumbleService(store, runtime);

    const scheduler = new Scheduler(store, (a, p, r, s) =>
      service.dispatch(a, p, r, s),
    );

    const restarted: string[] = [];

    const app = createAPI(service, scheduler, token, undefined, {
      restartWorkspace: async (agentId) => void restarted.push(agentId),
    });

    const agent = store.createAgent({
      name: "Desk",
      avatar: "bot",
      description: "",
      instructions: "",
      provider: "openai",
      model: "gpt-4.1",
      enabled: true,
      tools: [],
      skills: [],
      mcpServers: [],
      delegates: [],
    });

    const patch = (tools: string[]) =>
      req(app, `/v1/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ tools }),
      });

    await patch(["desktop"]);
    await patch(["desktop", "memory"]);
    await patch(["memory"]);

    expect(restarted).toEqual([agent.id, agent.id]);
  });

  test("lists a bot's desktop jobs", async () => {
    const { app, store } = setup();

    const agent = store.createAgent({
      name: "Desk",
      avatar: "bot",
      description: "",
      instructions: "",
      provider: "openai",
      model: "gpt-4.1",
      enabled: true,
      tools: ["desktop"],
      skills: [],
      mcpServers: [],
      delegates: [],
    });

    const res = await req(app, `/v1/agents/${agent.id}/desktop-jobs`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs: [] });
  });

  test("lists bundled and editable shared skills in one catalog", async () => {
    const dir = mkdtempSync(join("/tmp", "bot-api-common-"));
    dirs.push(dir);
    let sequence = 0;

    const runtime: any = {
      openChat: async (agent: { id: string }) => `${agent.id}:${++sequence}`,
      submit: async () => "submission",
      wait: async () => ({ status: "done" }),
      snapshot: async (_a: RuntimeAgent, conversationId: string) => ({
        conversationId,
        messages: [],
        live: null,
        status: "idle",
        updatedAt: Date.now(),
      }),
      abort: async () => {},
      deleteAgent: async () => {},
    };

    const store = new Store(dir);
    const service = new CrumbleService(store, runtime);

    const scheduler = new Scheduler(store, (a, p, r, s) =>
      service.dispatch(a, p, r, s),
    );

    const app = createAPI(service, scheduler, token, undefined, {
      commonSkills: [
        {
          id: "common:tasks/SKILL.md",
          name: "Tasks",
          instructions: "Use tasks",
          path: "tasks/SKILL.md",
        },
      ],
    });

    const response = await req(app, "/v1/skills");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        id: "common:tasks/SKILL.md",
        name: "Tasks",
        instructions: "Use tasks",
        path: "tasks/SKILL.md",
        source: "bundled",
      },
    ]);

    const mutation = await req(app, "/v1/skills/common:tasks%2FSKILL.md", {
      method: "PATCH",
      body: JSON.stringify({ name: "Nope", instructions: "Nope" }),
    });

    expect(mutation.status).toBe(405);
    store.close();
  });

  test("requires bearer auth and validates malformed requests", async () => {
    const { app, store } = setup();
    expect((await app.request("/v1/agents")).status).toBe(401);
    expect(
      (await req(app, "/v1/agents", { method: "POST", body: "{" })).status,
    ).toBe(400);
    expect(
      (
        await req(app, "/v1/agents", {
          method: "POST",
          body: JSON.stringify({ name: "" }),
        })
      ).status,
    ).toBe(400);
    store.close();
  });

  test("CRUDs agents, keeps one chat per bot, enforces idempotency and disabled agents", async () => {
    const { app, store } = setup();

    const created = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("One")),
    });

    expect(created.status).toBe(201);
    const agent = await created.json();

    const duplicate = await req(app, `/v1/agents/${agent.id}/duplicate`, {
      method: "POST",
    });

    expect(duplicate.status).toBe(201);
    const chat = await req(app, `/v1/agents/${agent.id}/chat`);
    expect(chat.status).toBe(200);
    const snapshot = await chat.json();
    expect(snapshot.agentId).toBe(agent.id);
    expect(
      (
        await req(app, `/v1/agents/${agent.id}/chat`).then((r: Response) =>
          r.json(),
        )
      ).conversationId,
    ).toBe(snapshot.conversationId);
    const requestId = "00000000-0000-4000-8000-000000000099";
    expect(
      (
        await req(app, `/v1/agents/${agent.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ content: "hello", requestId }),
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await req(app, `/v1/agents/${agent.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ content: "hello", requestId }),
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await req(app, `/v1/agents/${agent.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ content: "different", requestId }),
        })
      ).status,
    ).toBe(409);

    const disabled = await req(app, `/v1/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });

    expect(disabled.status).toBe(200);
    expect(
      (
        await req(app, `/v1/agents/${agent.id}/messages`, {
          method: "POST",
          body: JSON.stringify({
            content: "again",
            requestId: "00000000-0000-4000-8000-000000000100",
          }),
        })
      ).status,
    ).toBe(409);
    store.close();
  });

  test("accepts a bounded chat snapshot limit and rejects invalid limits", async () => {
    const { app, store, runtime } = setup();

    const agent = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("Limited")),
    }).then((r: Response) => r.json());

    let received: unknown;
    runtime.snapshot = async (
      _agent: RuntimeAgent,
      conversationId: string,
      options: SnapshotOptions,
    ) => {
      received = options;

      return {
        conversationId,
        messages: [],
        live: null,
        status: "idle",
        updatedAt: Date.now(),
      };
    };

    const limited = await req(app, `/v1/agents/${agent.id}/chat?limit=5`);
    expect(limited.status).toBe(200);
    expect(received).toEqual({ limit: 5 });
    expect((await req(app, `/v1/agents/${agent.id}/chat?limit=0`)).status).toBe(
      400,
    );
    expect(
      (await req(app, `/v1/agents/${agent.id}/chat?limit=201`)).status,
    ).toBe(400);
    store.close();
  });

  test("forwards the bounded limit to agent event snapshots", async () => {
    const { app, store, runtime } = setup();

    const agent = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("Event Limit")),
    }).then((r: Response) => r.json());

    let received: unknown;
    runtime.snapshot = async (
      _agent: RuntimeAgent,
      conversationId: string,
    ) => ({
      conversationId,
      messages: [],
      live: null,
      status: "idle",
      updatedAt: Date.now(),
    });
    runtime.watch = async (
      _agent: RuntimeAgent,
      _conversationId: string,
      _callback: EventCallback,
      options: SnapshotOptions,
    ) => {
      received = options;

      return async () => {};
    };

    const response = await req(app, `/v1/agents/${agent.id}/events?limit=5`);
    expect(response.status).toBe(200);
    expect(received).toEqual({ limit: 5 });
    await response.body?.cancel();
    store.close();
  });

  test("accepts attachments on messages only, within their limits", async () => {
    const { app } = setup();

    const agent = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("Files")),
    }).then((r: Response) => r.json());

    const send = (body: RequestBody) =>
      req(app, `/v1/agents/${agent.id}/messages`, {
        method: "POST",
        body: JSON.stringify(body),
      });

    const image = Buffer.alloc(2 * 1024 * 1024, 7).toString("base64");
    expect(
      (
        await send({
          content: "",
          requestId: crypto.randomUUID(),
          attachments: [
            { name: "big.png", mimeType: "image/png", data: image },
          ],
        })
      ).status,
    ).toBe(202);
    expect(
      (await send({ content: " ", requestId: crypto.randomUUID() })).status,
    ).toBe(400);

    const pdf = await send({
      content: "read",
      requestId: crypto.randomUUID(),
      attachments: [
        { name: "doc.pdf", mimeType: "application/pdf", data: "AAAA" },
      ],
    });

    expect(pdf.status).toBe(400);
    expect((await pdf.json()).error).toContain("only images");

    const memory = await req(app, `/v1/agents/${agent.id}/memories`, {
      method: "POST",
      body: JSON.stringify({ content: "x".repeat(2 * 1024 * 1024) }),
    });

    expect(memory.status).toBe(413);
  });

  test("streams server-wide activity", async () => {
    const { app } = setup();

    const agent = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("Notifier")),
    }).then((r: Response) => r.json());

    const response: Response = await req(app, "/v1/events");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    await req(app, `/v1/agents/${agent.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hi", requestId: crypto.randomUUID() }),
    });
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: activity");
    expect(text).toContain(`"agentId":"${agent.id}"`);
    await reader.cancel();
  });

  test("includes durable latest message in agent summaries and replays chat previews", async () => {
    const { app, runtime } = setup();

    const agent = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("Preview Bot")),
    }).then((r: Response) => r.json());

    await req(app, `/v1/agents/${agent.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: "hello sidebar",
        requestId: crypto.randomUUID(),
      }),
    });
    runtime.history = async () => ({
      messages: [{ role: "user", content: "hello sidebar" }],
    });
    const listed = await req(app, "/v1/agents").then((r: Response) => r.json());
    expect(listed[0]).toMatchObject({
      name: "Preview Bot",
      lastMessage: "hello sidebar",
    });

    const response = await req(app, "/v1/events");
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('"type":"chat-preview"');
    expect(text).toContain(`"agentName":"Preview Bot"`);
    expect(text).toContain('"lastMessage":"hello sidebar"');
    await reader.cancel();
  });

  test("describes how each MCP server signs in", async () => {
    const { app } = setup();

    const created = await req(app, "/v1/mcp-servers", {
      method: "POST",
      body: JSON.stringify({
        name: "Docs",
        url: "https://docs.example.com/mcp",
        enabled: true,
        token: "secret",
      }),
    }).then((r: Response) => r.json());

    const list = await req(app, "/v1/mcp-servers").then((r: Response) =>
      r.json(),
    );

    expect(list[0]).toMatchObject({
      id: created.id,
      auth: "token",
      authenticated: true,
    });
    expect(JSON.stringify(list)).not.toContain("secret");

    const bad = await req(app, `/v1/mcp-servers/${created.id}/oauth`, {
      method: "POST",
      body: JSON.stringify({ redirectUri: "not a uri" }),
    });

    expect(bad.status).toBe(400);

    const missing = await req(app, "/v1/mcp-servers/nope/oauth/callback", {
      method: "POST",
      body: JSON.stringify({ code: "c", state: "s" }),
    });

    expect(missing.status).toBe(404);

    const signedOut = await req(app, `/v1/mcp-servers/${created.id}/oauth`, {
      method: "DELETE",
    });

    expect((await signedOut.json()).auth).toBe("token");
  });

  test("isolates memories and never returns provider secrets", async () => {
    const { app, store } = setup();

    const a = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("A")),
    }).then((r: Response) => r.json());

    const b = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("B")),
    }).then((r: Response) => r.json());

    const memory = await req(app, `/v1/agents/${a.id}/memories`, {
      method: "POST",
      body: JSON.stringify({ content: "private" }),
    }).then((r: Response) => r.json());

    expect(
      (
        await req(app, `/v1/agents/${b.id}/memories/${memory.id}`, {
          method: "PATCH",
          body: JSON.stringify({ content: "leak" }),
        })
      ).status,
    ).toBe(404);
    await req(app, "/v1/providers/openai", {
      method: "PUT",
      body: JSON.stringify({ apiKey: "secret" }),
    });
    expect(
      JSON.stringify(
        await req(app, "/v1/providers").then((r: Response) => r.json()),
      ),
    ).not.toContain("secret");
    store.close();
  });

  test("reports each memory's source", async () => {
    const { app, store } = setup();

    const agent = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("A")),
    }).then((r: Response) => r.json());

    await req(app, `/v1/agents/${agent.id}/memories`, {
      method: "POST",
      body: JSON.stringify({ content: "from the owner" }),
    });
    store.createMemory({ agentId: agent.id, content: "older" });
    store.createMemory({
      agentId: agent.id,
      content: "from a group",
      source: { kind: "group", groupId: "group-1", name: "Trip" },
    });

    const memories = memoryResponse
      .array()
      .parse(
        await req(app, `/v1/agents/${agent.id}/memories`).then((r: Response) =>
          r.json(),
        ),
      );

    // Memories saved in the same millisecond have no defined order.
    expect(memories).toHaveLength(3);
    expect(memories.map((memory) => memory.source)).toEqual(
      expect.arrayContaining([
        { kind: "owner" },
        null,
        { kind: "group", groupId: "group-1", name: "Trip" },
      ]),
    );
    store.close();
  });

  test("creates and runs schedules through the scheduler API", async () => {
    const { app, store } = setup();

    const agent = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("Scheduled")),
    }).then((r: Response) => r.json());

    const schedule = await req(app, "/v1/schedules", {
      method: "POST",
      body: JSON.stringify({
        agentId: agent.id,
        name: "Now",
        prompt: "run",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        cron: null,
        timezone: "UTC",
        enabled: true,
      }),
    });

    expect(schedule.status).toBe(201);
    const value = await schedule.json();
    expect(
      (await req(app, `/v1/schedules/${value.id}/run`, { method: "POST" }))
        .status,
    ).toBe(202);
    expect((await req(app, "/v1/executions")).status).toBe(200);
    store.close();
  });
});
