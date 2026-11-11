import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  inertControl,
  inertCredentials,
  inertIntent,
  inertLogins,
} from "../../test/support/job-wiring";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../test/support/store";
import { codingPlugin } from "../jobs/coding";
import { desktopPlugin } from "../bot-desktop/desktop-jobs";
import { desktopControlAccess } from "../bot-desktop/desktop-control";
import { pathRegister } from "./api-requests";
import { handleApiError } from "./api-errors";
import { HeldActions, heldActionsAccess } from "../bot-desktop/held-actions";
import { ViewerTickets } from "../bot-desktop/desktop-viewer";
import { standaloneBots } from "../bots/bots-test-support";
import { standaloneScheduler } from "../automations/scheduler-test-support";
import { testAPI, type TestServices } from "../../test/support/api";
import { heldActionNotices } from "../bot-desktop/held-action-notices";
import { contractApp } from "../contract/api-contract";
import type { secretInput } from "../contract/secrets";
import type { z } from "zod";
import { registerMcpServerRoutes } from "../integrations/mcp-servers-api";
import type { McpIntegrations } from "../integrations/integrations";
import { BotDeletion } from "../bot-ports/bot-deletion";
import { Secrets } from "../secrets/secrets";
import { mcpServersOver } from "../integrations/integrations-test-support";
import { McpServers } from "../integrations/mcp-servers";
import { mcpTokenKey } from "../integrations/mcp-oauth";
import { registerPluginSettingRoutes } from "../plugins/plugin-settings-api";
import { memoryResponse } from "../contract/api-responses";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
  connectFakePasswordManager,
  fakePasswordManager,
  fakeVendor,
  type FakePasswordManager,
} from "../../test/support/fake-password-manager";
import { SecretValues } from "../secrets/secret-values";
import { secretsLayer } from "../secrets/secrets";
import { standaloneSignIns } from "../providers/provider-auth-test-support";
import { ProviderCredentials } from "../providers/provider-credentials";
import type { CoreServices } from "./core-layer";
import { runnerOf } from "../shared/runner";
import { ScriptRuns } from "../automations/script-runs";
import type { Workspaces } from "../workspaces/workspace";
import { ScriptRunRepository } from "../automations/script-run-repository";
import { scheduleInput, type ScheduleInput } from "../contract/schedules";
import type { ScriptRun } from "../automations/script-run-repository";
import type { MessageOrigin } from "../transcript/entries";
import { defaultAvatarDefinition } from "../contract/avatar";
import { until } from "../../test/support/until";

// Real runtimes and migrations can pass the default 5 seconds on a loaded machine.
setDefaultTimeout(30_000);

type TestRequestInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

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
  description: "",
  instructions: "help",
  provider: "openai" as const,
  model: "gpt-4.1",
  tools: [],
  skills: [],
  mcpServers: [],
  delegates: [],
});

// SAFETY: a route under test calls only the members given; script policy only checks that workspaces exist.
const workspacesWith = (members: Partial<Workspaces>) => members as Workspaces;

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup(options: TestServices = {}) {
  const dir = mkdtempSync(join("/tmp", "bot-api-"));
  dirs.push(dir);
  let sequence = 0;

  const runtime: any = {
    openChat: async (agent: { id: string }) => `${agent.id}:${++sequence}`,
    prepareInput: async (_agent: RuntimeAgent, text: string) => ({
      modelContent: text,
      data: { text },
    }),
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
    jobs: async () => [],
    close: async () => {},
  };

  const store = new Store(dir);
  const service = standaloneBots(store, runtime);

  const scheduler = standaloneScheduler(
    store.runtime,
    (a, p, r, s) => service.dispatch(a, p, r, s),
    undefined,
    options.workspaces,
  );

  return {
    app: testAPI(service, token, { scheduler, ...options }),
    store,
    runtime,
    service,
    scheduler,
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  text: string,
) {
  const decoder = new TextDecoder();
  let seen = "";

  while (!seen.includes(text)) {
    const { value, done } = await reader.read();

    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }

  return seen;
}

const req = (app: any, path: string, init: TestRequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });

describe("HTTP API for bots, chats, and activity", () => {
  test("reports whether the server can run coding jobs", async () => {
    const { app, store, runtime } = setup();
    const service = standaloneBots(store, runtime);

    const scheduler = standaloneScheduler(store.runtime, (a, p, r, s) =>
      service.dispatch(a, p, r, s),
    );

    const withCoding = testAPI(service, token, {
      scheduler,
      workspaces: workspacesWith({ desktop: false }),
    });

    const withDesktop = testAPI(service, token, {
      scheduler,
      workspaces: workspacesWith({ desktop: true }),
      plugins: [
        codingPlugin(workspacesWith({}), () => 0, inertCredentials),
        desktopPlugin(
          workspacesWith({ desktop: true }),
          inertControl,
          inertLogins,
          inertIntent,
        ),
      ],
    });

    const without = await req(app, "/v1/capabilities");
    expect(await without.json()).toEqual({
      coding: false,
      desktop: false,
      jobKinds: [],
    });
    expect(await (await req(withCoding, "/v1/capabilities")).json()).toEqual({
      coding: true,
      desktop: false,
      jobKinds: [],
    });
    expect(await (await req(withDesktop, "/v1/capabilities")).json()).toEqual({
      coding: true,
      desktop: true,
      jobKinds: ["coding", "desktop"],
    });
  });

  test("avatars use only validated canonical geometry and colors", async () => {
    const { app } = setup();

    const created = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Portable" }),
    });

    expect(created.status).toBe(201);
    const bot = await created.json();
    expect(bot.avatar).toEqual(defaultAvatarDefinition(bot.id));
    expect(bot).not.toHaveProperty("avatarDefinition");

    const custom = {
      ...defaultAvatarDefinition("new"),
      color: "#123",
      eyeColor: "#abc",
    };

    const updated = await req(app, `/v1/agents/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ avatar: custom }),
    });

    expect(updated.status).toBe(200);
    expect((await updated.json()).avatar).toEqual(custom);

    const partial = await req(app, `/v1/agents/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Partial edit" }),
    });

    expect((await partial.json()).avatar).toEqual(custom);
    const listing = await req(app, "/v1/agents");
    expect((await listing.json())[0].avatar).toEqual(custom);

    for (const method of ["POST", "PATCH"]) {
      const legacy = await req(
        app,
        method === "POST" ? "/v1/agents" : `/v1/agents/${bot.id}`,
        {
          method,
          body: JSON.stringify({
            name: "Legacy",
            avatar: "critters:old;silhouette=cloud;color=#38bdf8",
          }),
        },
      );

      expect(legacy.status).toBe(400);
    }

    const invalid = await req(app, `/v1/agents/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        avatar: {
          ...custom,
          definition: {
            ...custom.definition,
            eyes: { x: 0, y: 0, spacing: 16, scale: 1 },
          },
        },
      }),
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("eyes must sit inside the body");

    const invalidColor = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad",
        avatar: { ...custom, color: "url(bad)" },
      }),
    });

    expect(invalidColor.status).toBe(400);
    const kept = await req(app, `/v1/agents/${bot.id}`);
    expect((await kept.json()).avatar).toEqual(custom);
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
    const service = standaloneBots(store, runtime);

    const scheduler = standaloneScheduler(store.runtime, (a, p, r, s) =>
      service.dispatch(a, p, r, s),
    );

    const restarted: string[] = [];

    const app = testAPI(service, token, {
      scheduler,
      workspaces: workspacesWith({
        restart: (agentId) => Effect.sync(() => void restarted.push(agentId)),
      }),
    });

    const agent = store.createAgent({
      name: "Desk",
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
    const { app, store, runtime } = setup();

    const agent = store.createAgent({
      name: "Desk",
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

    runtime.jobs = async (owner: RuntimeAgent) => [
      {
        name: "github-login",
        conversationId: `${owner.id}:desktop`,
        status: "idle",
      },
    ];

    const res = await req(app, `/v1/agents/${agent.id}/desktop-jobs`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jobs: [
        {
          name: "github-login",
          conversationId: `${agent.id}:desktop`,
          status: "idle",
        },
      ],
    });
    expect(
      (await req(app, `/v1/agents/${crypto.randomUUID()}/desktop-jobs`)).status,
    ).toBe(404);
  });

  test("lists bundled and editable shared skills in one catalog", async () => {
    const dir = mkdtempSync(join("/tmp", "bot-api-common-"));
    dirs.push(dir);
    let sequence = 0;

    const runtime: any = {
      openChat: async (agent: { id: string }) => `${agent.id}:${++sequence}`,
      prepareInput: async (_agent: RuntimeAgent, text: string) => ({
        modelContent: text,
        data: { text },
      }),
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
    const service = standaloneBots(store, runtime);

    const scheduler = standaloneScheduler(store.runtime, (a, p, r, s) =>
      service.dispatch(a, p, r, s),
    );

    const app = testAPI(service, token, {
      scheduler,
      defaultSkills: [
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

    const deletion = await req(app, "/v1/skills/common:tasks%2FSKILL.md", {
      method: "DELETE",
    });

    expect(deletion.status).toBe(405);
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
    expect((await pdf.json()).error).toBe(
      "doc.pdf: only images (PNG, JPEG, GIF, WebP) and text files can be attached",
    );

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
    const text = await readUntil(reader, "event: activity");
    expect(text).toContain("event: activity");
    expect(text).toContain(`"agentId":"${agent.id}"`);
    await reader.cancel();
  });

  test("opens the activity stream with a heartbeat, so browsers connect without waiting", async () => {
    const { app } = setup();
    const response: Response = await req(app, "/v1/events");
    const reader = response.body!.getReader();

    const first = await Promise.race([
      reader.read().then(({ value }) => new TextDecoder().decode(value)),
      Bun.sleep(1000).then(() => "nothing within a second"),
    ]);

    expect(first).toContain("event: heartbeat");
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
    const text = await readUntil(reader, '"lastMessage"');
    expect(text).toContain('"type":"chat-preview"');
    expect(text).toContain(`"agentName":"Preview Bot"`);
    expect(text).toContain('"lastMessage":"hello sidebar"');
    await reader.cancel();
  });
});

describe("HTTP API for MCP servers, skills, and memory", () => {
  test("describes how each MCP server signs in", async () => {
    const { app } = setup();

    const created = await req(app, "/v1/mcp-servers", {
      method: "POST",
      body: JSON.stringify({
        name: "Docs",
        url: "https://docs.example.com/mcp",
        enabled: true,
        token: { value: "secret" },
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

  test("deletes a shared skill and drops it from every bot that used it", async () => {
    const { app, store } = setup();

    const agent = await req(app, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentInput("Reader")),
    }).then((r: Response) => r.json());

    const own = await req(app, `/v1/agents/${agent.id}/skills`, {
      method: "POST",
      body: JSON.stringify({ name: "Own", instructions: "x" }),
    }).then((r: Response) => r.json());

    const shared = await req(app, "/v1/skills", {
      method: "POST",
      body: JSON.stringify({ name: "Shared", instructions: "Read me" }),
    }).then((r: Response) => r.json());

    store.updateAgent(agent.id, { sharedSkills: [shared.id] });

    expect(
      (await req(app, `/v1/skills/${own.id}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect(
      (await req(app, "/v1/skills/missing", { method: "DELETE" })).status,
    ).toBe(404);

    const deleted = await req(app, `/v1/skills/${shared.id}`, {
      method: "DELETE",
    });

    expect(deleted.status).toBe(204);
    expect(store.getSkill(shared.id)).toBeNull();
    expect(store.getAgent(agent.id)?.sharedSkills).toEqual([]);
    store.close();
  });

  test("installed skills are read-only, and a bad repository location is the owner's to fix", async () => {
    const { app, store } = setup();

    const installed = store.createSkill({
      name: "Review",
      description: "",
      instructions: "Read it all.",
      documents: [],
      origin: {
        repository: "acme/skills",
        branch: "main",
        path: "skills/review",
        commit: "a".repeat(40),
        digest: "d",
      },
    });

    const edit = await req(app, `/v1/skills/${installed.id}`, {
      method: "PATCH",
      body: JSON.stringify({ instructions: "Changed" }),
    });

    expect(edit.status).toBe(405);
    expect(store.getSkill(installed.id)?.instructions).toBe("Read it all.");

    const listed = await req(app, "/v1/skills").then((r: Response) => r.json());

    expect(listed).toContainEqual(
      expect.objectContaining({
        id: installed.id,
        origin: expect.objectContaining({ repository: "acme/skills" }),
        update: null,
      }),
    );

    const browse = await req(app, "/v1/skills/github/browse", {
      method: "POST",
      body: JSON.stringify({ location: "not a repository" }),
    });

    expect(browse.status).toBe(400);
    expect((await browse.json()).error).toBe(
      "Enter owner/repo or a github.com URL",
    );
    store.close();
  });

  test("changes an MCP server's settings and keeps its secrets write-only", async () => {
    const { app, store } = setup();

    const created = await req(app, "/v1/mcp-servers", {
      method: "POST",
      body: JSON.stringify({
        name: "Docs",
        url: "https://docs.example.com/mcp",
        token: { value: "token-secret" },
      }),
    }).then((r: Response) => r.json());

    const patch = (body: {
      name?: string;
      oauthClientId?: string;
      oauthClientSecret?: { value: string } | null;
    }) =>
      req(app, `/v1/mcp-servers/${created.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });

    const renamed = await patch({ name: "Docs 2" });

    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      name: "Docs 2",
      oauthClientId: null,
    });

    const secretWritten = await patch({
      oauthClientId: "client-id",
      oauthClientSecret: { value: "client-secret" },
    });

    expect(secretWritten.status).toBe(200);
    expect(JSON.stringify(await secretWritten.json())).not.toContain(
      "client-secret",
    );

    const described = async () =>
      (await req(app, "/v1/mcp-servers").then((r: Response) => r.json()))[0];

    expect(await described()).toMatchObject({
      auth: "token",
      authenticated: true,
      oauthClientId: "client-id",
      oauthClientSecret: { configured: true },
    });

    const otherClient = await patch({ oauthClientId: "other-client-id" });

    expect(otherClient.status).toBe(200);
    expect((await otherClient.json()).oauthClientId).toBe("other-client-id");

    const secretRemoved = await patch({ oauthClientSecret: null });

    expect(secretRemoved.status).toBe(200);
    expect((await described()).oauthClientSecret.configured).toBe(false);
    expect(
      (
        await req(app, "/v1/mcp-servers/missing", {
          method: "PATCH",
          body: JSON.stringify({ name: "Nobody" }),
        })
      ).status,
    ).toBe(404);
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
      body: JSON.stringify({ value: "secret" }),
    });
    expect(
      JSON.stringify(
        await req(app, "/v1/providers").then((r: Response) => r.json()),
      ),
    ).not.toContain("secret");
    store.close();
  });

  test("skill assignment copies by provenance, preserves edits, and never removes name matches", async () => {
    const { app, store } = setup();
    const a = store.createAgent(agentInput("A"));
    const b = store.createAgent(agentInput("B"));

    const input = {
      name: "Research",
      description: "Check sources",
      instructions: "Read everything",
      documents: [{ path: "references/check.md", content: "Cite sources" }],
    };

    const source = store.createSkill({ ...input, agentId: a.id, pinned: true });
    const unrelated = store.createSkill({ ...input, agentId: b.id });

    const assign = (skillId: string, botId: string, assigned: boolean) =>
      req(app, `/v1/skills/${skillId}/assignment`, {
        method: "POST",
        body: JSON.stringify({ botId, assigned }),
      });

    expect(await (await assign(source.id, b.id, true)).json()).toEqual({
      skipped: false,
    });

    const copy = store
      .listSkills(b.id)
      .find((skill) => skill.id !== unrelated.id)!;

    expect(copy).toMatchObject({
      ...input,
      agentId: b.id,
      copiedFromSkillId: source.id,
      pinned: false,
      createdBy: "owner",
      state: "active",
    });
    expect(copy.id).not.toBe(source.id);
    await req(app, `/v1/agents/${b.id}/skills/${copy.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "Edited copy",
        instructions: "Keep my edits",
        copiedFromSkillId: unrelated.id,
      }),
    });
    expect(await (await assign(source.id, b.id, true)).json()).toEqual({
      skipped: true,
    });
    expect(store.listSkills(b.id)).toHaveLength(2);
    expect(store.getSkill(copy.id)).toMatchObject({
      name: "Edited copy",
      instructions: "Keep my edits",
      copiedFromSkillId: source.id,
    });
    expect(await (await assign(source.id, a.id, false)).json()).toEqual({
      skipped: true,
    });
    expect(store.getSkill(source.id)).not.toBeNull();
    expect(await (await assign(source.id, b.id, false)).json()).toEqual({
      skipped: false,
    });
    expect(store.getSkill(copy.id)).toBeNull();
    expect(store.getSkill(unrelated.id)).not.toBeNull();
    expect(await (await assign(source.id, b.id, false)).json()).toEqual({
      skipped: true,
    });

    await assign(source.id, b.id, true);

    const surviving = store
      .listSkills(b.id)
      .find((skill) => skill.copiedFromSkillId === source.id)!;

    await req(app, `/v1/agents/${a.id}/skills/${source.id}`, {
      method: "DELETE",
    });
    expect(store.getSkill(surviving.id)?.copiedFromSkillId).toBe(source.id);
    expect((await assign(source.id, b.id, false)).status).toBe(404);
    const replacement = store.createSkill({ ...input, agentId: a.id });
    expect(await (await assign(replacement.id, b.id, false)).json()).toEqual({
      skipped: true,
    });
    expect(store.getSkill(surviving.id)).not.toBeNull();
    expect(
      (await assign(replacement.id, crypto.randomUUID(), true)).status,
    ).toBe(404);
    store.close();
    const reopened = new Store(dirs.at(-1)!);
    expect(reopened.getSkill(surviving.id)?.copiedFromSkillId).toBe(source.id);
    reopened.close();
  });

  test("shared assignment changes only the chosen skill and refuses defaults and overflow", async () => {
    const { app, store } = setup({
      defaultSkills: [
        {
          id: "default",
          name: "Default",
          description: "Default",
          instructions: "x",
          documents: [],
          path: "/skills/default",
        },
      ],
    });

    const bot = store.createAgent(agentInput("Bot"));

    const shared = store.createSkill({
      name: "Shared",
      description: "",
      instructions: "x",
      documents: [],
    });

    const other = store.createSkill({
      name: "Other",
      description: "",
      instructions: "x",
      documents: [],
    });

    store.updateAgent(bot.id, { sharedSkills: [other.id] });

    const assign = (id: string, assigned: boolean) =>
      req(app, `/v1/skills/${id}/assignment`, {
        method: "POST",
        body: JSON.stringify({ botId: bot.id, assigned }),
      });

    expect(await (await assign(shared.id, true)).json()).toEqual({
      skipped: false,
    });
    expect(store.getAgent(bot.id)?.sharedSkills).toEqual(
      [other.id, shared.id].toSorted(),
    );
    expect(await (await assign(shared.id, true)).json()).toEqual({
      skipped: true,
    });
    expect(await (await assign(shared.id, false)).json()).toEqual({
      skipped: false,
    });
    expect(store.getAgent(bot.id)?.sharedSkills).toEqual([other.id]);
    expect((await assign("default", true)).status).toBe(405);
    store.updateAgent(bot.id, {
      sharedSkills: Array.from({ length: 100 }, () => crypto.randomUUID()),
    });
    expect((await assign(shared.id, true)).status).toBe(400);
    expect(store.getAgent(bot.id)?.sharedSkills).toHaveLength(100);
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
});

describe("HTTP API for script tasks and schedules", () => {
  test("owner script tasks require coding jobs and workspaces on create and update", async () => {
    const { app, store, scheduler } = setup({ workspaces: workspacesWith({}) });
    const plain = store.createAgent(agentInput("Plain"));

    const coder = store.createAgent({
      ...agentInput("Coder"),
      tools: ["coding"],
    });

    const draft = {
      agentId: plain.id,
      name: "Check",
      kind: "script" as const,
      command: "echo ok",
      runAt: new Date(Date.now() + 60_000).toISOString(),
    };

    const create = (body: Partial<ScheduleInput>) =>
      req(app, "/v1/schedules", { method: "POST", body: JSON.stringify(body) });

    const denied = await create(draft);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: "Script automations need coding jobs",
    });

    const prompt = scheduler.create(
      scheduleInput.parse({
        ...draft,
        kind: "prompt",
        command: null,
        prompt: "Check",
      }),
    );

    const patch = (id: string, body: Partial<ScheduleInput>) =>
      req(app, `/v1/schedules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });

    expect(
      (await patch(prompt.id, { kind: "script", command: "echo ok" })).status,
    ).toBe(403);
    const saved = await create({ ...draft, agentId: coder.id });
    expect(saved.status).toBe(201);
    const task = await saved.json();
    expect(task).toMatchObject({
      kind: "script",
      command: "echo ok",
      prompt: "",
      timeoutSeconds: 600,
      notify: true,
    });
    expect((await patch(task.id, { agentId: plain.id })).status).toBe(403);

    const delegated = scheduler.create(
      scheduleInput.parse({
        ...draft,
        agentId: coder.id,
        kind: "prompt",
        command: null,
        prompt: "Check",
      }),
      plain.id,
    );

    expect(
      (await patch(delegated.id, { kind: "script", command: "echo ok" }))
        .status,
    ).toBe(403);
    store.close();

    const without = setup();

    const bot = without.store.createAgent({
      ...agentInput("Coder"),
      tools: ["coding"],
    });

    const unavailable = await req(without.app, "/v1/schedules", {
      method: "POST",
      body: JSON.stringify({ ...draft, agentId: bot.id }),
    });

    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual({
      error: "This server has no workspaces",
    });

    const existing = without.store.createSchedule(
      scheduleInput.parse({ ...draft, agentId: bot.id }),
    );

    const update = await req(without.app, `/v1/schedules/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ notify: false }),
    });

    expect(update.status).toBe(409);
    without.store.close();
  });

  test("converting a script task requires a prompt and clears its command without workspaces", async () => {
    const { app, store } = setup();
    const agent = store.createAgent(agentInput("Former coder"));

    const script = store.createSchedule(
      scheduleInput.parse({
        agentId: agent.id,
        name: "Check",
        kind: "script",
        command: "true",
        cron: "0 9 * * *",
      }),
    );

    const patch = (body: Partial<ScheduleInput>) =>
      req(app, `/v1/schedules/${script.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });

    expect((await patch({ kind: "prompt" })).status).toBe(400);
    expect(store.getSchedule(script.id)?.kind).toBe("script");
    const converted = await patch({ kind: "prompt", prompt: "Check results" });
    expect(converted.status).toBe(200);
    expect(await converted.json()).toMatchObject({
      kind: "prompt",
      prompt: "Check results",
      command: null,
    });
    store.close();
  });

  test("lists script runs newest first, pages and validates queries, and rejects an unknown task", async () => {
    const { store, service, scheduler } = setup();

    const repository = store.runtime.runSync(
      ScriptRunRepository.use(Effect.succeed),
    );

    const scriptRuns = ScriptRuns.of({
      start: () => Effect.succeed({ admitted: false }),
      recover: Effect.void,
      list: repository.list,
    });

    const app = testAPI(service, token, { scheduler, scriptRuns });

    const agent = store.createAgent({
      ...agentInput("Coder"),
      tools: ["coding"],
    });

    const schedule = store.createSchedule(
      scheduleInput.parse({
        agentId: agent.id,
        name: "Check",
        kind: "script",
        command: "echo ok",
        cron: "0 9 * * *",
      }),
    );

    const startedAt = new Date().toISOString();
    const olderAt = new Date(Date.now() - 1000).toISOString();

    const run = (id: string, at: string): ScriptRun => ({
      id,
      scheduleId: schedule.id,
      agentId: agent.id,
      command: "echo ok",
      status: "succeeded",
      exitCode: 0,
      output: "ok",
      droppedBytes: 0,
      error: null,
      startedAt: at,
      finishedAt: at,
    });

    const older = run("older", olderAt);
    const newest = run("newest", startedAt);
    store.runtime.runSync(repository.create(older));
    store.runtime.runSync(repository.create(newest));
    const path = `/v1/schedules/${schedule.id}/runs`;
    expect(await (await req(app, path)).json()).toEqual([newest, older]);
    expect(await (await req(app, `${path}?limit=1`)).json()).toEqual([newest]);
    expect(
      await (await req(app, `${path}?before=${newest.id}`)).json(),
    ).toEqual([older]);
    expect(await (await req(app, `${path}?before=unknown`)).json()).toEqual([]);

    for (const query of ["limit=0", "limit=201", "limit=bad", "before="])
      expect((await req(app, `${path}?${query}`)).status).toBe(400);
    expect(
      (await req(app, `/v1/schedules/${crypto.randomUUID()}/runs`)).status,
    ).toBe(404);
    store.close();
  });

  test("a script result notice reaches the bot with the script origin and task name", async () => {
    const { store, service, runtime } = setup();

    const agent = store.createAgent({
      ...agentInput("Coder"),
      tools: ["coding"],
    });

    const task = store.createSchedule(
      scheduleInput.parse({
        agentId: agent.id,
        name: "Daily check",
        kind: "script",
        command: "echo ok",
        cron: "0 9 * * *",
      }),
    );

    let origin: MessageOrigin | undefined;
    runtime.submit = async (
      _agent: RuntimeAgent,
      _chat: string,
      _text: string,
      _requestId: string,
      options: { origin: MessageOrigin },
    ) => {
      origin = options.origin;

      return "submission-script";
    };

    await service.notice(
      agent.id,
      "Daily check succeeded",
      `script:${task.id}:run-1`,
    );
    expect(origin).toEqual({ kind: "script", name: "Daily check" });
    await service.notice(agent.id, "Saved", "login:github:notice-1");
    expect(origin).toEqual({ kind: "credential", name: "github" });
    await service.close();
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
    expect(value.description).toStartWith("Once,");
    expect(value.timing).toBe(value.description);
    const listed = await (await req(app, "/v1/schedules")).json();
    expect(listed).toContainEqual(value);

    const updated = await (
      await req(app, `/v1/schedules/${value.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      })
    ).json();

    expect(updated.description).toBe(value.description);
    expect(updated.timing).toBe(`Paused · ${value.description}`);
    await req(app, `/v1/schedules/${value.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });

    const ran = await req(app, `/v1/schedules/${value.id}/run`, {
      method: "POST",
    });

    expect(ran.status).toBe(202);
    const { result } = await ran.json();

    expect(result).toMatchObject({
      agentId: agent.id,
      scheduleId: value.id,
      prompt: "run",
      status: "running",
    });
    expect(await (await req(app, "/v1/executions")).json()).toMatchObject([
      { id: result.id, scheduleId: value.id, prompt: "run" },
    ]);
    store.close();
  });
});

describe("bot desktop control and viewer", () => {
  function desktopApp(
    tools = ["desktop"],
    workspace: Partial<Workspaces> = {},
  ) {
    const { store, runtime } = setup();
    const service = standaloneBots(store, runtime);

    const scheduler = standaloneScheduler(store.runtime, (a, p, r, s) =>
      service.dispatch(a, p, r, s),
    );

    const desktopControl = desktopControlAccess(store.runtime);
    const viewerTickets = new ViewerTickets();

    const app = testAPI(service, token, {
      scheduler,
      workspaces: workspacesWith({
        desktop: true,
        desktopRunning: () => false,
        startDesktop: () => Effect.void,
        ...workspace,
      }),
      viewerTickets,
    });

    const agent = store.createAgent({
      name: "Desk",
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

    expect(viewerTickets.redeem(path.split("/").at(-1))).toEqual({
      agentId: agent.id,
      passive: false,
    });
    expect((await app.request(path)).status).toBe(404);
    expect((await app.request(`${path}/websockify`)).status).toBe(404);
  });

  test("the desktop status reports a running bot desktop", async () => {
    const running = new Set<string>();

    const { app, agent } = desktopApp(["desktop"], {
      desktopRunning: (id) => running.has(id),
    });

    const url = `/v1/agents/${agent.id}/desktop/status`;

    expect(await (await req(app, url)).json()).toEqual({ running: false });

    running.add(agent.id);

    expect(await (await req(app, url)).json()).toEqual({ running: true });

    const plain = desktopApp([], { desktopRunning: () => true });

    expect(
      await (
        await req(plain.app, `/v1/agents/${plain.agent.id}/desktop/status`)
      ).json(),
    ).toEqual({ running: false });
  });

  test("a passive viewer link watches without booting the machine", async () => {
    const booted: string[] = [];

    const { app, agent, viewerTickets } = desktopApp(["desktop"], {
      startDesktop: (id) => Effect.sync(() => void booted.push(id)),
    });

    const url = `/v1/agents/${agent.id}/desktop/viewer`;

    const passive = await req(app, `${url}?passive=true`, { method: "POST" });
    const { path } = await passive.json();

    expect(passive.status).toBe(201);
    expect(viewerTickets.redeem(path.split("/").at(-1))).toEqual({
      agentId: agent.id,
      passive: true,
    });

    await req(app, url, { method: "POST" });
    await until(() => booted.length > 0);

    expect(booted).toEqual([agent.id]);
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
    const service = standaloneBots(store, runtime);
    const heard: unknown[] = [];

    const agent = store.createAgent({
      name: "Desk",
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

describe("held action notifications", () => {
  test("an action held for the owner's approval becomes a reply event naming the job", async () => {
    const { store, runtime } = setup();
    const service = standaloneBots(store, runtime);
    const heard: unknown[] = [];
    const scope = Scope.makeUnsafe();

    const agent = store.createAgent({
      name: "Desk",
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

    await service.effects.runPromise(
      Layer.buildWithScope(heldActionNotices, scope).pipe(
        Effect.provideService(
          HeldActions,
          store.runtime.runSync(HeldActions.use(Effect.succeed)),
        ),
      ),
    );

    const held = await heldActionsAccess(store.runtime).hold({
      agentId: agent.id,
      job: "github",
      action: "click Delete repository",
      page: null,
      ownerMessages: [],
      reason: "Irreversible",
    });

    while (!heard.length)
      await new Promise((resolve) => setTimeout(resolve, 5));

    expect(heard).toEqual([
      {
        type: "reply",
        executionId: held.id,
        agentId: agent.id,
        agentName: "Desk",
        entryId: null,
        origin: "desktop",
        jobName: "github",
        waitingFor: "approval",
        preview: "Waiting for your approval: click Delete repository",
        createdAt: held.heldAt,
      },
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});

describe("provider API keys from a password manager", () => {
  const REFERENCE = "op://Vault/OpenAI/key";

  const reference = {
    reference: { passwordManager: "1password", reference: REFERENCE },
  } as const;

  function vaultSetup(state: FakePasswordManager) {
    const { store, service, scheduler } = setup();
    const core = store.run(Effect.context<CoreServices>());
    const scope = Scope.makeUnsafe();

    const vault = Effect.runSync(
      Layer.buildWithScope(
        ProviderCredentials.layer.pipe(
          Layer.provideMerge(secretsLayer([fakeVendor(state)])),
          Layer.provide(Layer.succeedContext(core)),
        ),
        scope,
      ),
    );

    store.run(connectFakePasswordManager);

    const providerAuth = standaloneSignIns(
      runnerOf(Context.merge(core, vault)),
      [],
    );

    const app = testAPI(service, token, {
      scheduler,
      providerAuth,
    });

    return {
      app,
      credentials: Context.get(vault, ProviderCredentials),
      put: (
        body:
          | { value: string }
          | typeof reference
          | ({ value: string } & typeof reference),
      ) =>
        req(app, "/v1/providers/openai", {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      openai: async () =>
        (await req(app, "/v1/providers").then((r: Response) => r.json())).find(
          (provider: { provider: string }) => provider.provider === "openai",
        ),
      close: () => {
        Effect.runSync(Scope.close(scope, Exit.void));
        store.close();
      },
    };
  }

  test("a reference is stored and the model's key is read from the password manager", async () => {
    const api = vaultSetup(fakePasswordManager({ [REFERENCE]: "sk-vault" }));

    expect((await api.put(reference)).status).toBe(200);
    expect(await api.openai()).toMatchObject({
      credentialType: "api_key",
      apiKey: { passwordManager: "1password", reference: REFERENCE },
    });
    expect(await api.credentials.read("openai")).toEqual({
      type: "api_key",
      key: "sk-vault",
    });
    api.close();
  });

  test("a reference that can't be read answers 400 and keeps the previous key", async () => {
    const state = fakePasswordManager();
    const api = vaultSetup(state);

    await api.put({ value: "sk-stored" });
    state.mode = "unreachable";

    const response = await api.put(reference);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Fake could not be reached",
    });
    expect(await api.openai()).toMatchObject({
      apiKey: { passwordManager: null, reference: null },
    });
    expect(await api.credentials.read("openai")).toEqual({
      type: "api_key",
      key: "sk-stored",
    });
    api.close();
  });

  test("a body with both a key and a reference is rejected, even an empty key", async () => {
    const api = vaultSetup(fakePasswordManager({ [REFERENCE]: "sk-vault" }));

    for (const value of ["sk-typed", ""])
      expect((await api.put({ value, ...reference })).status).toBe(400);

    expect(await api.openai()).toMatchObject({ credentialType: null });
    api.close();
  });
});

describe("MCP server tokens from a password manager", () => {
  const REFERENCE = "op://Vault/Linear/token";
  const OTHER_REFERENCE = "op://Vault/Linear/other";

  const reference = (path = REFERENCE) => ({
    passwordManager: "1password" as const,
    reference: path,
  });

  type ServerBody = {
    name?: string;
    url?: string;
    agentId?: string;
    token?: { value?: string; reference?: ReturnType<typeof reference> } | null;
  };

  function mcpSetup(state: FakePasswordManager) {
    const { store, service } = setup();
    const core = store.run(Effect.context<CoreServices>());
    const scope = Scope.makeUnsafe();

    const vault = Effect.runSync(
      Layer.buildWithScope(
        secretsLayer([fakeVendor(state)]).pipe(
          Layer.provide(Layer.succeedContext(core)),
        ),
        scope,
      ),
    );

    store.run(connectFakePasswordManager);

    const run = runnerOf(Context.merge(core, vault));
    const disconnected: string[] = [];

    const integrations: McpIntegrations["Service"] = {
      oauthClient: undefined,
      failure: () => null,
      extensionsForAgent: async () => [],
      codemodeNamespaces: () => [],
      disconnect: (serverId) =>
        Effect.sync(() => {
          disconnected.push(serverId);
        }),
    };

    const app = contractApp();

    app.onError(handleApiError);
    registerMcpServerRoutes({
      register: pathRegister(app),
      service,
      run: runnerOf(
        Context.add(
          Context.merge(core, vault),
          McpServers,
          mcpServersOver(Context.merge(core, vault), integrations),
        ),
      ),
    });
    registerPluginSettingRoutes({
      register: pathRegister(app),
      run,
      plugins: [
        {
          id: "chat",
          settings: [
            { key: "token", kind: "secret", label: "Token", whenMissing: "" },
          ],
        },
      ],
    });

    const send = (method: string, path: string, body?: ServerBody) =>
      app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body && { body: JSON.stringify(body) }),
      });

    return {
      state,
      store,
      run,
      disconnected,
      create: (body: ServerBody) =>
        send("POST", "/v1/mcp-servers", {
          name: "Linear",
          url: "https://mcp.linear.app/mcp",
          ...body,
        }),
      patch: (id: string, body: ServerBody) =>
        send("PATCH", `/v1/mcp-servers/${id}`, body),
      remove: (id: string) => send("DELETE", `/v1/mcp-servers/${id}`),
      list: async () => (await send("GET", "/v1/mcp-servers")).json(),
      setPluginToken: (body: z.input<typeof secretInput>) =>
        app.request("/v1/plugin-settings/chat/token", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      read: (path: string) =>
        run.runPromise(
          SecretValues.use((values) => values.read(reference(path))),
        ),
      close: () => {
        Effect.runSync(Scope.close(scope, Exit.void));
        store.close();
      },
    };
  }

  test("a server created with a token reference lists where its token is read from", async () => {
    const api = mcpSetup(fakePasswordManager({ [REFERENCE]: "lin_vault" }));
    const response = await api.create({ token: { reference: reference() } });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      token: { passwordManager: "1password", reference: REFERENCE },
    });
    expect(await api.list()).toMatchObject([
      {
        auth: "token",
        token: { passwordManager: "1password", reference: REFERENCE },
      },
    ]);
    api.close();
  });

  test("deleting a bot forgets its own servers' secrets and connections", async () => {
    const api = mcpSetup(fakePasswordManager());
    const bot = api.store.createAgent(agentInput("Ada"));

    const { id }: { id: string } = await (
      await api.create({ agentId: bot.id, token: { value: "lin_secret" } })
    ).json();

    const clear = await api.run.runPromise(
      BotDeletion.use((deletion) => deletion.prepare(bot.id)),
    );

    api.store.deleteAgent(bot.id);
    await api.run.runPromise(clear);

    expect(api.disconnected).toEqual([id]);
    expect(
      await api.run.runPromise(Secrets.use((s) => s.status(mcpTokenKey(id)))),
    ).toMatchObject({ configured: false });
    api.close();
  });

  test("deleting a server closes its connection", async () => {
    const api = mcpSetup(fakePasswordManager());
    const created: { id: string } = await (await api.create({})).json();

    expect((await api.remove(created.id)).status).toBe(204);
    expect(api.disconnected).toEqual([created.id]);
    api.close();
  });

  test("a plugin setting reads from a password manager only when its reference can be read", async () => {
    const api = mcpSetup(fakePasswordManager({ [REFERENCE]: "chat_vault" }));

    const missing = await api.setPluginToken({
      reference: reference("op://vault/missing/token"),
    });

    expect(missing.status).toBe(400);
    expect(
      (
        await api.setPluginToken({
          value: "chat_stored",
          reference: reference(),
        })
      ).status,
    ).toBe(400);
    expect((await api.setPluginToken({})).status).toBe(400);

    const saved = await api.setPluginToken({ reference: reference() });

    expect(await saved.json()).toMatchObject({
      secret: {
        configured: true,
        passwordManager: "1password",
        reference: REFERENCE,
      },
    });

    const stored = await api.setPluginToken({ value: "chat_stored" });

    expect(await stored.json()).toMatchObject({
      secret: { configured: true, passwordManager: null, reference: null },
    });
    api.close();
  });

  test("replacing a token reference with a token reads nothing and closes the connection", async () => {
    const api = mcpSetup(fakePasswordManager({ [REFERENCE]: "lin_vault" }));

    const { id } = await (
      await api.create({ token: { reference: reference() } })
    ).json();

    api.state.mode = "unreachable";

    const response = await api.patch(id, { token: { value: "lin_stored" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      token: { passwordManager: null, reference: null },
    });
    expect(api.state.reads).toBe(1);
    expect(api.disconnected).toEqual([id]);
    api.close();
  });

  test("a new token reference closes the connection and forgets the old value", async () => {
    const api = mcpSetup(
      fakePasswordManager({
        [REFERENCE]: "lin_vault",
        [OTHER_REFERENCE]: "lin_other",
      }),
    );

    const { id } = await (
      await api.create({ token: { reference: reference() } })
    ).json();

    await api.read(REFERENCE);
    expect(api.state.reads).toBe(1);

    expect(
      (
        await api.patch(id, {
          token: { reference: reference(OTHER_REFERENCE) },
        })
      ).status,
    ).toBe(200);
    expect(api.disconnected).toEqual([id]);

    await api.read(REFERENCE);
    expect(api.state.reads).toBe(3);
    api.close();
  });

  test("a token reference that can't be read answers 400 and changes nothing", async () => {
    const api = mcpSetup(fakePasswordManager({ [REFERENCE]: "lin_vault" }));

    const { id } = await (
      await api.create({ token: { reference: reference() } })
    ).json();

    api.state.mode = "unreachable";

    const response = await api.patch(id, {
      name: "Renamed",
      token: { reference: reference(OTHER_REFERENCE) },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Fake could not be reached",
    });
    expect(
      (await api.create({ token: { reference: reference() } })).status,
    ).toBe(400);
    expect(await api.list()).toMatchObject([
      { id, name: "Linear", token: { reference: REFERENCE } },
    ]);
    expect(api.disconnected).toEqual([]);
    api.close();
  });

  test("a token and a token reference together are rejected", async () => {
    const api = mcpSetup(fakePasswordManager({ [REFERENCE]: "lin_vault" }));

    expect(
      (
        await api.create({
          token: { value: "lin_stored", reference: reference() },
        })
      ).status,
    ).toBe(400);
    expect(await api.list()).toEqual([]);
    api.close();
  });
});

describe("vision model", () => {
  test("is off by default, refuses a model no key reaches, and turns off with null", async () => {
    const { app, store } = setup();

    const get = await req(app, "/v1/vision-model");
    expect(get.status).toBe(200);
    expect((await get.json()).visionModel).toBeNull();

    const unknown = await req(app, "/v1/vision-model", {
      method: "PUT",
      body: JSON.stringify({
        visionModel: { provider: "nowhere", model: "eyes" },
      }),
    });

    expect(unknown.status).toBe(400);

    const off = await req(app, "/v1/vision-model", {
      method: "PUT",
      body: JSON.stringify({ visionModel: null }),
    });

    expect(off.status).toBe(200);
    expect((await off.json()).visionModel).toBeNull();
    store.close();
  });
});
