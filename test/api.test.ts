import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store";
import { CrumbleService } from "../src/service";
import { Scheduler } from "../src/scheduler";
import { createAPI } from "../src/api";

const token = "t".repeat(40);
const agentInput = (name: string, enabled = true) => ({
  name,
  enabled,
  avatar: "sparkles",
  description: "",
  instructions: "help",
  provider: "openai" as const,
  model: "gpt-4.1",
  folder: "Personal",
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
    createConversation: async () =>
      `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    submit: async (_a: unknown, _c: string, _text: string, requestId: string) =>
      `submission-${requestId}`,
    wait: async () => ({ status: "done" }),
    snapshot: async (_a: unknown, conversationId: string) => ({
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
  return { app: createAPI(service, scheduler, token), store };
}
const req = (app: any, path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

describe("HTTP API", () => {
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

  test("CRUDs agents and conversations, enforces idempotency and disabled agents", async () => {
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
    const conversationResponse = await req(
      app,
      `/v1/agents/${agent.id}/conversations`,
      { method: "POST", body: JSON.stringify({ title: "Chat" }) },
    );
    expect(conversationResponse.status).toBe(201);
    const conversation = await conversationResponse.json();
    const requestId = "00000000-0000-4000-8000-000000000099";
    expect(
      (
        await req(app, `/v1/conversations/${conversation.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ content: "hello", requestId }),
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await req(app, `/v1/conversations/${conversation.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ content: "hello", requestId }),
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await req(app, `/v1/conversations/${conversation.id}/messages`, {
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
        await req(app, `/v1/conversations/${conversation.id}/messages`, {
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
