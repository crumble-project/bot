import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store";
import { DesktopControl } from "../src/desktop-control";
import { ViewerTickets } from "../src/desktop-viewer";
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

    const agent = await created.json();

    expect(agent.desktopModel).toEqual({
      provider: "opencode-go",
      model: "gpt-6-luna",
    });

    // Omitting it keeps the override; null clears it, so jobs use the bot's model again.
    const kept = await req(app, `/v1/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Desk 2" }),
    });

    expect((await kept.json()).desktopModel).toEqual({
      provider: "opencode-go",
      model: "gpt-6-luna",
    });

    const cleared = await req(app, `/v1/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({ desktopModel: null }),
    });

    expect(cleared.status).toBe(200);
    expect((await cleared.json()).desktopModel).toBeUndefined();
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
          documents: [],
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
        documents: [],
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

  test("manages a bot's own skill packages apart from the shared library", async () => {
    const { app, store } = setup();

    const a = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        ...agentInput("A"),
        skills: [{ name: "Research", instructions: "Check sources" }],
      }),
    }).then((r: Response) => r.json());

    const b = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("B")),
    }).then((r: Response) => r.json());

    const own = await req(app, `/v1/agents/${a.id}/skills`).then(
      (r: Response) => r.json(),
    );

    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      agentId: a.id,
      name: "Research",
      instructions: "Check sources",
      documents: [],
      createdBy: "owner",
      state: "active",
    });

    const created = await req(app, `/v1/agents/${a.id}/skills`, {
      method: "POST",
      body: JSON.stringify({
        name: "Writing",
        description: "House style",
        instructions: "Short sentences",
        documents: [{ path: "references/tone.md", content: "Plain words" }],
      }),
    });

    expect(created.status).toBe(201);
    const writing = await created.json();
    expect(writing.documents).toEqual([
      { path: "references/tone.md", content: "Plain words" },
    ]);

    const agent = await req(app, `/v1/agents/${a.id}`).then((r: Response) =>
      r.json(),
    );

    expect(agent.skills).toEqual([
      { name: "Research", instructions: "Check sources" },
      { name: "Writing", instructions: "Short sentences" },
    ]);

    expect(
      (
        await req(app, `/v1/agents/${a.id}/skills`, {
          method: "POST",
          body: JSON.stringify({
            name: "Bad",
            instructions: "x",
            documents: [{ path: "../etc/passwd", content: "x" }],
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req(app, `/v1/agents/${b.id}/skills/${writing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ instructions: "leak" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(app, `/v1/skills/${writing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ instructions: "leak" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await req(app, "/v1/skills").then((r: Response) => r.json())).map(
        (skill: { id: string }) => skill.id,
      ),
    ).not.toContain(writing.id);

    const patched = await req(app, `/v1/agents/${a.id}/skills/${writing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ instructions: "Shorter sentences" }),
    }).then((r: Response) => r.json());

    expect(patched).toMatchObject({
      instructions: "Shorter sentences",
      description: "House style",
      documents: [{ path: "references/tone.md", content: "Plain words" }],
    });
    expect(
      (
        await req(app, `/v1/agents/${a.id}/skills/${writing.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(
      (await req(app, `/v1/agents/${a.id}`).then((r: Response) => r.json()))
        .skills,
    ).toEqual([{ name: "Research", instructions: "Check sources" }]);

    // Packages may outgrow the inline limit without blocking unrelated edits; a submitted list is still bounded.
    for (let i = 0; i < 100; i++)
      await req(app, `/v1/agents/${a.id}/skills`, {
        method: "POST",
        body: JSON.stringify({ name: `Skill ${i}`, instructions: "x" }),
      });
    expect(store.listSkills(a.id)).toHaveLength(101);

    const disabled = await req(app, `/v1/agents/${a.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });

    expect(disabled.status).toBe(200);
    expect((await disabled.json()).skills).toHaveLength(101);
    expect(store.listSkills(a.id)).toHaveLength(101);
    expect(
      (
        await req(app, `/v1/agents/${a.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            skills: Array.from({ length: 101 }, (_, i) => ({
              name: `S${i}`,
              instructions: "x",
            })),
          }),
        })
      ).status,
    ).toBe(400);
    store.close();
  });

  test("lists learned changes and reverts one", async () => {
    const { app, store } = setup();

    const agent = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("A")),
    }).then((r: Response) => r.json());

    const skill = await req(app, `/v1/agents/${agent.id}/skills`, {
      method: "POST",
      body: JSON.stringify({ name: "Writing", instructions: "Short" }),
    }).then((r: Response) => r.json());

    await req(app, `/v1/agents/${agent.id}/skills/${skill.id}`, {
      method: "PATCH",
      body: JSON.stringify({ instructions: "Shorter" }),
    });
    await req(app, "/v1/memories", {
      method: "POST",
      body: JSON.stringify({ content: "shared fact" }),
    });

    const changes = await req(app, `/v1/changes?agentId=${agent.id}`).then(
      (r: Response) => r.json(),
    );

    expect(
      changes.map((change: { action: string; target: string }) => [
        change.target,
        change.action,
      ]),
    ).toEqual([
      ["skill", "update"],
      ["skill", "create"],
    ]);
    expect(changes[0]).toMatchObject({
      actor: "owner",
      agentId: agent.id,
      before: { instructions: "Short" },
      after: { instructions: "Shorter" },
    });
    expect(
      (
        await req(app, "/v1/changes?agentId=shared").then((r: Response) =>
          r.json(),
        )
      ).map((change: { target: string }) => change.target),
    ).toEqual(["memory"]);
    expect(
      (await req(app, "/v1/changes").then((r: Response) => r.json())).length,
    ).toBe(3);
    expect((await req(app, "/v1/changes?agentId=nope")).status).toBe(400);

    const reverted = await req(app, `/v1/changes/${changes[0].id}/revert`, {
      method: "POST",
    });

    expect(reverted.status).toBe(201);
    expect(await reverted.json()).toMatchObject({
      action: "revert",
      revertsId: changes[0].id,
      after: { instructions: "Short" },
    });
    expect(
      (
        await req(app, `/v1/agents/${agent.id}/skills`).then((r: Response) =>
          r.json(),
        )
      )[0].instructions,
    ).toBe("Short");
    expect(
      (await req(app, "/v1/changes/missing/revert", { method: "POST" })).status,
    ).toBe(404);
    expect(
      await req(app, `/v1/agents/${agent.id}/reviews`).then((r: Response) =>
        r.json(),
      ),
    ).toEqual([]);
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

describe("bot desktop control and viewer", () => {
  function desktopApp(tools = ["desktop"]) {
    const { store, runtime } = setup();
    const service = new CrumbleService(store, runtime);

    const scheduler = new Scheduler(store, (a, p, r, s) =>
      service.dispatch(a, p, r, s),
    );

    const desktopControl = new DesktopControl(store);
    const viewerTickets = new ViewerTickets();

    const app = createAPI(service, scheduler, token, undefined, {
      desktop: true,
      desktopControl,
      viewerTickets,
    });

    const agent = store.createAgent({
      name: "Desk",
      avatar: "bot",
      description: "",
      instructions: "",
      provider: "openai",
      model: "gpt-4.1",
      enabled: true,
      tools,
      skills: [],
      mcpServers: [],
      delegates: [],
    });

    return { app, agent, desktopControl, viewerTickets };
  }

  test("the owner takes control and hands it back", async () => {
    const { app, agent } = desktopApp();
    const url = `/v1/agents/${agent.id}/desktop/control`;

    expect(await (await req(app, url)).json()).toMatchObject({
      holder: "bot",
      changes: 0,
    });

    const taken = await req(app, url, {
      method: "PUT",
      body: JSON.stringify({ holder: "owner" }),
    });

    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ holder: "owner", changes: 1 });

    const back = await req(app, url, {
      method: "PUT",
      body: JSON.stringify({ holder: "bot" }),
    });

    expect(await back.json()).toMatchObject({ holder: "bot", changes: 2 });
  });

  test("a bot without its bot desktop cannot be controlled or watched", async () => {
    const { app, agent } = desktopApp([]);

    const put = await req(app, `/v1/agents/${agent.id}/desktop/control`, {
      method: "PUT",
      body: JSON.stringify({ holder: "owner" }),
    });

    expect(put.status).toBe(409);
    expect(
      (
        await req(app, `/v1/agents/${agent.id}/desktop/viewer`, {
          method: "POST",
        })
      ).status,
    ).toBe(409);
  });

  test("a viewer link loads its page until its connection spends it", async () => {
    const { app, agent, viewerTickets } = desktopApp();

    const created = await req(app, `/v1/agents/${agent.id}/desktop/viewer`, {
      method: "POST",
    });

    expect(created.status).toBe(201);

    const { path } = await created.json();

    expect(path).toStartWith("/desktop-viewer/");

    const page = await app.request(path);

    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain(`${path}/websockify`);

    // The WebSocket redeems the ticket; afterwards the link is dead.
    expect(viewerTickets.redeem(path.split("/").at(-1))).toBe(agent.id);
    expect((await app.request(path)).status).toBe(404);
    expect((await app.request(`${path}/websockify`)).status).toBe(404);
  });

  test("only noVNC's core and vendored files are served", async () => {
    const { app } = desktopApp();
    const rfb = await app.request("/desktop-viewer/novnc/core/rfb.js");

    expect(rfb.status).toBe(200);
    expect(rfb.headers.get("content-type")).toContain("javascript");
    expect(
      (
        await app.request(
          "/desktop-viewer/novnc/vendor/pako/lib/zlib/inflate.js",
        )
      ).status,
    ).toBe(200);
    expect((await app.request("/desktop-viewer/novnc/app/ui.js")).status).toBe(
      404,
    );
    expect(
      (await app.request("/desktop-viewer/novnc/core/../package.json")).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          "/desktop-viewer/novnc/core/%2e%2e/%2e%2e/LICENSE.txt",
        )
      ).status,
    ).toBe(404);
  });

  test("viewer links and control need the owner's token", async () => {
    const { app, agent } = desktopApp();

    const viewer = await app.request(`/v1/agents/${agent.id}/desktop/viewer`, {
      method: "POST",
    });

    expect(viewer.status).toBe(401);
  });

  test("desktop events start with the current control and follow each change", async () => {
    const { app, agent, desktopControl } = desktopApp();
    const res = await req(app, `/v1/agents/${agent.id}/desktop/events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";

    const readUntil = async (text: string) => {
      while (!received.includes(text))
        received += decoder.decode((await reader.read()).value);
    };

    await readUntil('"holder":"bot"');
    expect(received).toContain("event: control");

    desktopControl.set(agent.id, "owner");
    await readUntil('"holder":"owner"');
    await reader.cancel();
  });
});

describe("job answer notifications", () => {
  test("the bot's answer to a job report becomes a reply event with the job's origin and name", () => {
    const { store, runtime } = setup();
    const service = new CrumbleService(store, runtime);
    const heard: unknown[] = [];

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

    service.onActivity((event) => heard.push(event));

    service.announceJobAnswer({
      agentId: agent.id,
      kind: "desktop",
      name: "github-login",
      entryId: "7",
      preview: "The job needs you to log in to GitHub.",
      eventId: "desktop-report:42",
    });

    // A bot of another server in the same process is not ours to announce.
    service.announceJobAnswer({
      agentId: "00000000-0000-4000-8000-000000000999",
      kind: "desktop",
      name: "x",
      entryId: "1",
      preview: "x",
      eventId: "desktop-report:1",
    });

    expect(heard).toEqual([
      {
        type: "reply",
        executionId: "desktop-report:42",
        agentId: agent.id,
        agentName: "Desk",
        entryId: `${agent.id}:7`,
        origin: "desktop",
        jobName: "github-login",
        preview: "The job needs you to log in to GitHub.",
        createdAt: expect.any(String),
      },
    ]);
  });
});
