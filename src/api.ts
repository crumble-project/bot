import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  agentInput,
  scheduleInput,
  skillInput,
  AppError,
  type MCPServer,
} from "./domain";
import type { CrumbleService } from "./service";
import type { Scheduler } from "./scheduler";
import type { MCPIntegrations } from "./integrations";
import { providerModels } from "./runtime";
import type { CommonSkill } from "./common-skills";
import {
  finishAuthorization,
  hasOAuthTokens,
  signOut,
  startAuthorization,
} from "./mcp-oauth";
import {
  attachmentInput,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_BODY,
} from "./attachments";

const text = z.string().trim().min(1).max(32000);
const catalog = providerModels();
const provider = z
  .string()
  .refine((value) => Boolean(catalog.getProvider(value)), "Unknown provider");

export function createAPI(
  service: CrumbleService,
  scheduler: Scheduler,
  token: string,
  integrations?: MCPIntegrations,
  options: { commonSkills?: CommonSkill[] } = {},
) {
  if (token.length < 32)
    throw new Error("Server token must contain at least 32 characters");
  const { store, runtime } = service;
  const app = new Hono();
  // Messages may carry attachments; every other request stays small.
  const messageBodyLimit = bodyLimit({ maxSize: MAX_MESSAGE_BODY });
  const defaultBodyLimit = bodyLimit({ maxSize: 1024 * 1024 });
  app.use("*", (c, next) =>
    c.req.method === "POST" &&
    /^\/v1\/agents\/[^/]+\/messages$/.test(c.req.path)
      ? messageBodyLimit(c, next)
      : defaultBodyLimit(c, next),
  );
  app.get("/health", (c) => c.json({ status: "ok", apiVersion: 1 }));
  app.use("/v1/*", bearerAuth({ token }));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof z.ZodError)
      return c.json({ error: "Invalid request", details: error.issues }, 400);
    if (error instanceof AppError)
      return c.json({ error: error.message }, error.status as 400);
    if (error instanceof SyntaxError)
      return c.json({ error: "Invalid JSON" }, 400);
    console.error(error);
    return c.json({ error: "The server could not complete this request" }, 500);
  });

  // A bot may use shared servers and its own, never another bot's.
  const checkServers = (agentId: string | null, serverIds: string[]) => {
    for (const serverId of serverIds) {
      const owner = store.getMCPServer(serverId)?.agentId;
      if (owner && owner !== agentId)
        throw new AppError(400, "That MCP server belongs to another bot");
    }
  };
  app.get("/v1/agents", async (c) =>
    c.json(
      (await service.agentPreviews()).map(({ agent, lastMessage }) => ({
        ...agent,
        ...(lastMessage ? { lastMessage } : {}),
      })),
    ),
  );
  app.post("/v1/agents", async (c) => {
    const input = agentInput.parse(await c.req.json());
    provider.parse(input.provider);
    checkServers(null, input.mcpServers);
    return c.json(store.createAgent(input), 201);
  });
  app.get("/v1/agents/:id", (c) => c.json(service.agent(c.req.param("id"))));
  app.patch("/v1/agents/:id", async (c) => {
    const old = service.agent(c.req.param("id"));
    const input = agentInput.parse({ ...old, ...(await c.req.json()) });
    provider.parse(input.provider);
    checkServers(old.id, input.mcpServers);
    if (!input.enabled && old.enabled)
      for (const conversation of store.listConversations(old.id))
        await service.abort(conversation.id);
    return c.json(store.updateAgent(old.id, input));
  });
  app.post("/v1/agents/:id/duplicate", (c) => {
    service.agent(c.req.param("id"));
    return c.json(store.duplicateAgent(c.req.param("id")), 201);
  });
  app.delete("/v1/agents/:id", async (c) => {
    const personal = store
      .listMCPServers()
      .filter((server) => server.agentId === c.req.param("id"));
    await service.deleteAgent(c.req.param("id"));
    // The bot's personal servers went with it; their credentials and connections go too.
    for (const server of personal) {
      store.deleteCredential(`mcp:${server.id}`);
      signOut(store, server.id);
      await integrations?.disconnect(server.id);
    }
    return c.body(null, 204);
  });
  app.get("/v1/agents/:id/chat", async (c) =>
    c.json(await service.chatSnapshot(c.req.param("id"))),
  );
  app.get("/v1/agents/:id/chat/history", async (c) => {
    const input = z
      .object({
        before: z.string().min(1).max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(c.req.query());
    return c.json(await service.history(c.req.param("id"), input));
  });
  app.post("/v1/agents/:id/messages", async (c) => {
    const input = z
      .object({
        content: z.string().trim().max(32000),
        requestId: z.string().uuid(),
        replyTo: z.string().min(1).max(200).optional(),
        attachments: z.array(attachmentInput).max(MAX_ATTACHMENTS).default([]),
      })
      .refine((value) => value.content || value.attachments.length, {
        message: "Write a message or attach a file",
        path: ["content"],
      })
      .parse(await c.req.json());
    return c.json(
      await service.sendChat(
        c.req.param("id"),
        input.content,
        input.requestId,
        input.replyTo,
        input.attachments,
      ),
      202,
    );
  });
  app.get("/v1/agents/:id/attachments/:entryId/:index", async (c) => {
    const index = z.coerce
      .number()
      .int()
      .min(0)
      .max(MAX_ATTACHMENTS - 1)
      .parse(c.req.param("index"));
    const image = await runtime.attachment(
      service.agent(c.req.param("id")),
      c.req.param("entryId"),
      index,
    );
    return c.body(new Uint8Array(image.data), 200, {
      "Content-Type": image.mimeType,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });
  app.post("/v1/agents/:id/abort", async (c) => {
    await service.abortChat(c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/v1/agents/:id/compact", async (c) =>
    c.json({ taskId: await service.compact(c.req.param("id")) }, 202),
  );
  app.get("/v1/agents/:id/events", async (c) => {
    const agent = service.agent(c.req.param("id"));
    const chat = await service.chat(agent.id);
    return streamSSE(c, async (stream) => {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      stream.onAbort(finish);
      const sendSnapshot = async () => {
        if (!stream.aborted)
          await stream.writeSSE({
            event: "snapshot",
            data: JSON.stringify(await service.snapshot(chat.id)),
          });
      };
      const unsubscribe = service.subscribe(chat.id, () => {
        void sendSnapshot().catch(finish);
      });
      let stop: (() => Promise<void>) | undefined;
      try {
        stop = await runtime.watch(agent, chat.id, sendSnapshot);
      } catch (error) {
        unsubscribe();
        throw error;
      }
      const timer = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(finish);
      }, 15000);
      try {
        await finished;
      } finally {
        clearInterval(timer);
        unsubscribe();
        await stop?.();
      }
    });
  });

  // Server-wide activity for notifications: finished replies from every bot.
  app.get("/v1/events", (c) =>
    streamSSE(c, async (stream) => {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      stream.onAbort(finish);
      const send = (data: unknown) => {
        if (!stream.aborted)
          stream
            .writeSSE({ event: "activity", data: JSON.stringify(data) })
            .catch(finish);
      };
      const unsubscribers = [service.onActivity(send)];
      // Replay current previews on every connection so a sidebar can recover missed events.
      try {
        for (const { agent, lastMessage } of await service.agentPreviews())
          send({
            type: "chat-preview",
            agentId: agent.id,
            agentName: agent.name,
            lastMessage,
          });
      } catch (error) {
        for (const unsubscribe of unsubscribers) unsubscribe?.();
        throw error;
      }
      const timer = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(finish);
      }, 15000);
      try {
        await finished;
      } finally {
        clearInterval(timer);
        for (const unsubscribe of unsubscribers) unsubscribe?.();
      }
    }),
  );

  app.get("/v1/agents/:id/memories", (c) => {
    service.agent(c.req.param("id"));
    return c.json(store.listMemories(c.req.param("id")));
  });
  app.post("/v1/agents/:id/memories", async (c) => {
    service.agent(c.req.param("id"));
    const input = z.object({ content: text }).parse(await c.req.json());
    return c.json(
      store.createMemory({
        agentId: c.req.param("id"),
        content: input.content,
      }),
      201,
    );
  });
  app.patch("/v1/agents/:id/memories/:memoryId", async (c) => {
    const memory = store.getMemory(c.req.param("memoryId"));
    if (!memory || memory.agentId !== c.req.param("id"))
      throw new AppError(404, "Memory not found");
    return c.json(
      store.updateMemory(
        memory.id,
        z.object({ content: text }).parse(await c.req.json()),
      ),
    );
  });
  app.delete("/v1/agents/:id/memories/:memoryId", (c) => {
    const memory = store.getMemory(c.req.param("memoryId"));
    if (!memory || memory.agentId !== c.req.param("id"))
      throw new AppError(404, "Memory not found");
    store.deleteMemory(memory.id);
    return c.body(null, 204);
  });
  const sharedMemory = (id: string) => {
    const memory = store.getMemory(id);
    if (!memory || memory.agentId !== null)
      throw new AppError(404, "Memory not found");
    return memory;
  };
  app.get("/v1/memories", (c) => c.json(store.listMemories(null)));
  app.post("/v1/memories", async (c) => {
    const input = z.object({ content: text }).parse(await c.req.json());
    return c.json(
      store.createMemory({ agentId: null, content: input.content }),
      201,
    );
  });
  app.patch("/v1/memories/:id", async (c) => {
    const memory = sharedMemory(c.req.param("id"));
    return c.json(
      store.updateMemory(
        memory.id,
        z.object({ content: text }).parse(await c.req.json()),
      ),
    );
  });
  app.delete("/v1/memories/:id", (c) => {
    store.deleteMemory(sharedMemory(c.req.param("id")).id);
    return c.body(null, 204);
  });
  app.get("/v1/skills", (c) =>
    c.json([
      ...(options.commonSkills ?? []).map(
        ({ id, name, description, instructions, path }) => ({
          id,
          name,
          ...(description ? { description } : {}),
          instructions,
          path,
          source: "bundled" as const,
        }),
      ),
      ...store
        .listSkills()
        .map((skill) => ({ ...skill, source: "shared" as const })),
    ]),
  );
  app.post("/v1/skills", async (c) =>
    c.json(store.createSkill(skillInput.parse(await c.req.json())), 201),
  );
  app.patch("/v1/skills/:id", async (c) => {
    if (options.commonSkills?.some((skill) => skill.id === c.req.param("id")))
      throw new AppError(405, "Bundled skills are read-only");
    const old = store.getSkill(c.req.param("id"));
    if (!old) throw new AppError(404, "Skill not found");
    return c.json(
      store.updateSkill(
        old.id,
        skillInput.parse({ ...old, ...(await c.req.json()) }),
      ),
    );
  });
  app.delete("/v1/skills/:id", (c) => {
    const skillId = c.req.param("id");
    if (options.commonSkills?.some((skill) => skill.id === skillId))
      throw new AppError(405, "Bundled skills are read-only");
    if (!store.deleteSkill(skillId)) throw new AppError(404, "Skill not found");
    for (const agent of store.listAgents())
      if (agent.sharedSkills?.includes(skillId))
        store.updateAgent(agent.id, {
          sharedSkills: agent.sharedSkills.filter((id) => id !== skillId),
        });
    return c.body(null, 204);
  });
  app.get("/v1/schedules", (c) =>
    c.json(store.listSchedules(c.req.query("agentId"))),
  );
  app.post("/v1/schedules", async (c) =>
    c.json(
      await scheduler.create(scheduleInput.parse(await c.req.json())),
      201,
    ),
  );
  app.patch("/v1/schedules/:id", async (c) => {
    const old = store.getSchedule(c.req.param("id"));
    if (!old) throw new AppError(404, "Schedule not found");
    return c.json(
      await scheduler.update(
        old.id,
        scheduleInput.parse({ ...old, ...(await c.req.json()) }),
      ),
    );
  });
  app.delete("/v1/schedules/:id", (c) => {
    if (!store.deleteSchedule(c.req.param("id")))
      throw new AppError(404, "Schedule not found");
    return c.body(null, 204);
  });
  app.post("/v1/schedules/:id/run", async (c) =>
    c.json(await scheduler.runNow(c.req.param("id")), 202),
  );
  app.get("/v1/executions", (c) =>
    c.json(store.listExecutions(c.req.query("agentId"))),
  );
  const authenticatedModels = providerModels((name) =>
    store.getCredential(name),
  );
  app.get("/v1/providers", async (c) =>
    c.json(
      await Promise.all(
        catalog.getProviders().map(async (item) => ({
          provider: item.id,
          name: item.name,
          configured: Boolean(
            await authenticatedModels.checkAuth(item.id).catch(() => undefined),
          ),
        })),
      ),
    ),
  );
  // Dynamic providers list their models only after a refresh with the saved key.
  const refreshed = async (name: string | undefined) => {
    await authenticatedModels.refresh(name ? { providers: [name] } : {});
    return authenticatedModels.getModels(name);
  };
  app.get("/v1/models", async (c) => {
    const name = c.req.query("provider");
    if (name) provider.parse(name);
    return c.json(
      (await refreshed(name)).map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
      })),
    );
  });
  app.put("/v1/providers/:provider", async (c) => {
    const name = provider.parse(c.req.param("provider"));
    const input = z
      .object({ apiKey: z.string().trim().min(1).max(16000) })
      .parse(await c.req.json());
    store.setCredential(name, input.apiKey);
    return c.json({ provider: name, configured: true });
  });
  app.delete("/v1/providers/:provider", (c) => {
    store.deleteCredential(provider.parse(c.req.param("provider")));
    return c.body(null, 204);
  });
  const describeServer = (server: MCPServer) => {
    const auth = hasOAuthTokens(store, server.id)
      ? "oauth"
      : store.getCredential(`mcp:${server.id}`)
        ? "token"
        : "none";
    return { ...server, auth, authenticated: auth !== "none" };
  };
  const mcpServer = (id: string) => {
    const server = store.getMCPServer(id);
    if (!server) throw new AppError(404, "MCP server not found");
    return server;
  };
  app.get("/v1/mcp-servers", (c) =>
    c.json(store.listMCPServers().map(describeServer)),
  );
  // OAuth sign-in: the client opens the returned URL, then posts back the code, state and issuer it receives.
  app.post("/v1/mcp-servers/:id/oauth", async (c) => {
    const { redirectUri } = z
      .object({
        redirectUri: z
          .string()
          .max(500)
          .regex(/^[a-z][a-z0-9+.-]*:\S+$/i, "Use an absolute redirect URI"),
      })
      .parse(await c.req.json());
    return c.json(
      await startAuthorization(
        store,
        mcpServer(c.req.param("id")),
        redirectUri,
      ),
    );
  });
  app.post("/v1/mcp-servers/:id/oauth/callback", async (c) => {
    const { code, state, iss } = z
      .object({
        code: z.string().min(1).max(4000),
        state: z.string().min(1).max(200),
        iss: z.string().min(1).max(500).optional(),
      })
      .parse(await c.req.json());
    const server = mcpServer(c.req.param("id"));
    await finishAuthorization(store, server, code, state, iss);
    await integrations?.disconnect(server.id);
    return c.json(describeServer(server));
  });
  app.delete("/v1/mcp-servers/:id/oauth", async (c) => {
    const server = mcpServer(c.req.param("id"));
    signOut(store, server.id);
    await integrations?.disconnect(server.id);
    return c.json(describeServer(server));
  });
  const mcpInput = z.object({
    name: z.string().trim().min(1).max(100),
    url: z
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        "Use an HTTP or HTTPS URL",
      ),
    enabled: z.boolean().default(true),
    token: z.string().max(16000).optional(),
  });
  // A server added with `agentId` belongs to that bot, which starts using it right away.
  app.post("/v1/mcp-servers", async (c) => {
    const input = mcpInput
      .extend({ agentId: z.string().uuid().nullable().default(null) })
      .parse(await c.req.json());
    const owner = input.agentId ? service.agent(input.agentId) : null;
    if (owner && owner.mcpServers.length >= 30)
      throw new AppError(400, `${owner.name} already uses 30 MCP servers`);
    const server = store.createMCPServer(input);
    if (input.token) store.setCredential(`mcp:${server.id}`, input.token);
    if (owner)
      store.updateAgent(owner.id, {
        mcpServers: [...owner.mcpServers, server.id],
      });
    return c.json(server, 201);
  });
  app.patch("/v1/mcp-servers/:id", async (c) => {
    const old = store.getMCPServer(c.req.param("id"));
    if (!old) throw new AppError(404, "MCP server not found");
    const input = mcpInput.parse({ ...old, ...(await c.req.json()) });
    if (input.token !== undefined)
      input.token
        ? store.setCredential(`mcp:${old.id}`, input.token)
        : store.deleteCredential(`mcp:${old.id}`);
    return c.json(store.updateMCPServer(old.id, input));
  });
  app.delete("/v1/mcp-servers/:id", (c) => {
    if (!store.deleteMCPServer(c.req.param("id")))
      throw new AppError(404, "MCP server not found");
    store.deleteCredential(`mcp:${c.req.param("id")}`);
    signOut(store, c.req.param("id"));
    return c.body(null, 204);
  });
  return app;
}
