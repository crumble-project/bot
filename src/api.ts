import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import {
  routes,
  contractApp,
  memoryInput,
  snapshotInput,
  historyInput,
  messageInput,
  activityInput,
  pushInput,
  presenceInput,
  providerKeyInput,
  oauthInput,
  oauthCallbackInput,
  mcpInput,
  mcpCreateInput,
  attachmentIndex,
} from "./api-contract";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type {
  activityFeedResponse,
  chatSnapshotResponse,
} from "./api-responses";
import {
  agentInput,
  scheduleInput,
  skillInput,
  AppError,
  type MCPServer,
} from "./domain";
import type { CrumbleService } from "./service";
import type { ChatPreviewActivity, ReplyActivity } from "./service";
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
import { MAX_MESSAGE_BODY } from "./attachments";
import { operationalActivity, sortActivity } from "./activity";
import type { TranscriptMessage } from "./transcript";
import {
  canonicalReplyEvent,
  type PushManager,
  type PushDeviceInput,
} from "./push";

const catalog = providerModels();

const provider = z
  .string()
  .refine((value) => Boolean(catalog.getProvider(value)), "Unknown provider");

export function createAPI(
  service: CrumbleService,
  scheduler: Scheduler,
  token: string,
  integrations?: MCPIntegrations,
  options: {
    commonSkills?: CommonSkill[];
    /** Whether the server can give bots the coding tool. */
    coding?: boolean;
  } = {},
  push?: PushManager,
) {
  if (token.length < 32)
    throw new Error("Server token must contain at least 32 characters");
  const { store, runtime } = service;
  const app = contractApp();

  const register = <R extends RouteConfig>(
    definition: R & { getRoutingPath: () => string },
    handler: RouteHandler<R>,
  ) => {
    // Keep merge-before-validation PATCH semantics and existing JSON error handling.
    app.openAPIRegistry.registerPath(definition);
    app.on(definition.method, definition.getRoutingPath(), handler);
  };

  // Messages may carry attachments; every other request stays small.
  const messageBodyLimit = bodyLimit({ maxSize: MAX_MESSAGE_BODY });
  const defaultBodyLimit = bodyLimit({ maxSize: 1024 * 1024 });
  app.use("*", (c, next) =>
    c.req.method === "POST" &&
    /^\/v1\/agents\/[^/]+\/messages$/.test(c.req.path)
      ? messageBodyLimit(c, next)
      : defaultBodyLimit(c, next),
  );
  register(routes.health, (c) =>
    c.json({ status: "ok", apiVersion: 1 } as const, 200),
  );
  app.use("/v1/*", bearerAuth({ token }));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();

    if (error instanceof z.ZodError)
      return c.json({ error: "Invalid request", details: error.issues }, 400);

    if (error instanceof AppError) {
      // SAFETY: AppError status codes are constructed from the server's known HTTP responses.
      return c.json({ error: error.message }, error.status as 400);
    }

    if (error instanceof SyntaxError)
      return c.json({ error: "Invalid JSON" }, 400);
    console.error(error);

    return c.json({ error: "The server could not complete this request" }, 500);
  });

  register(routes.capabilities, (c) =>
    c.json({ coding: options.coding === true }, 200),
  );
  register(routes.pushStatus, (c) =>
    c.json(
      {
        serverId: push?.serverId ?? "",
        transports: {
          apns: !!push?.transports.apns,
          fcm: !!push?.transports.fcm,
        },
      },
      200,
    ),
  );
  register(routes.putDevice, async (c) => {
    if (!push) throw new AppError(503, "Push delivery is unavailable");

    const installationId = z
      .string()
      .uuid()
      .parse(c.req.param("installationId"));

    const input: PushDeviceInput = pushInput.parse(await c.req.json());

    return c.json(push.device(installationId, input), 200);
  });
  register(routes.deleteDevice, (c) => {
    push?.remove(z.string().uuid().parse(c.req.param("installationId")));

    return c.body(null, 204);
  });
  register(routes.putPresence, async (c) => {
    if (!push) throw new AppError(503, "Push delivery is unavailable");
    const id = z.string().uuid().parse(c.req.param("installationId"));

    const input = presenceInput.parse(await c.req.json());

    if (!push.presence(id, input.active, input.agentId))
      throw new AppError(404, "Push device not found");

    return c.body(null, 204);
  });

  // A bot may use shared servers and its own, never another bot's.
  const checkServers = (agentId: string | null, serverIds: string[]) => {
    for (const serverId of serverIds) {
      const owner = store.getMCPServer(serverId)?.agentId;

      if (owner && owner !== agentId)
        throw new AppError(400, "That MCP server belongs to another bot");
    }
  };

  register(routes.listAgents, async (c) =>
    c.json(
      (await service.agentPreviews()).map(({ agent, lastMessage }) => {
        return lastMessage ? { ...agent, lastMessage } : agent;
      }),
      200,
    ),
  );
  register(routes.createAgent, async (c) => {
    const input = agentInput.parse(await c.req.json());
    provider.parse(input.provider);
    checkServers(null, input.mcpServers);

    return c.json(store.createAgent(input), 201);
  });
  register(routes.getAgent, (c) =>
    c.json(service.agent(c.req.param("id")), 200),
  );
  register(routes.updateAgent, async (c) => {
    const old = service.agent(c.req.param("id"));
    const input = agentInput.parse({ ...old, ...(await c.req.json()) });
    provider.parse(input.provider);
    checkServers(old.id, input.mcpServers);

    if (!input.enabled && old.enabled)
      for (const conversation of store.listConversations(old.id))
        await service.abort(conversation.id);

    return c.json(store.updateAgent(old.id, input), 200);
  });
  register(routes.duplicateAgent, (c) => {
    service.agent(c.req.param("id"));

    return c.json(store.duplicateAgent(c.req.param("id")), 201);
  });
  register(routes.deleteAgent, async (c) => {
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

  const snapshotQuery = (c: { req: { query: () => Record<string, string> } }) =>
    snapshotInput.parse(c.req.query());

  register(routes.chat, async (c) => {
    const snapshot: z.output<typeof chatSnapshotResponse> =
      await service.chatSnapshot(c.req.param("id"), snapshotQuery(c));

    return c.json(snapshot, 200);
  });
  register(routes.history, async (c) => {
    const input = historyInput.parse(c.req.query());

    return c.json(await service.history(c.req.param("id"), input), 200);
  });
  register(routes.codingJobs, async (c) =>
    c.json({ jobs: await service.codingJobs(c.req.param("id")) }, 200),
  );
  register(routes.codingJobHistory, async (c) =>
    c.json(
      await service.codingJobHistory(
        c.req.param("id"),
        c.req.param("name"),
        historyInput.parse(c.req.query()),
      ),
      200,
    ),
  );
  register(routes.sendMessage, async (c) => {
    const input = messageInput.parse(await c.req.json());

    return c.json(
      await service.sendChat(
        c.req.param("id"),
        input.content,
        input.requestId,
        input.replyTo,
        input.attachments,
        input.timezone,
      ),
      202,
    );
  });
  register(routes.attachment, async (c) => {
    const index = attachmentIndex.parse(c.req.param("index"));

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
  register(routes.abort, async (c) => {
    await service.abortChat(c.req.param("id"));

    return c.body(null, 204);
  });
  register(routes.compact, async (c) =>
    c.json({ taskId: await service.compact(c.req.param("id")) }, 202),
  );
  register(routes.chatEvents, async (c) => {
    const options = snapshotQuery(c);
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
            data: JSON.stringify(await service.snapshot(chat.id, options)),
          });
      };

      const unsubscribe = service.subscribe(chat.id, () => {
        void sendSnapshot().catch(finish);
      });

      let stop: (() => Promise<void>) | undefined;

      try {
        stop = await runtime.watch(agent, chat.id, sendSnapshot, options);
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
  register(routes.events, (c) =>
    streamSSE(c, async (stream) => {
      let finish!: () => void;

      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });

      stream.onAbort(finish);

      const send = (data: ReplyActivity | ChatPreviewActivity) => {
        const activity = data;

        const canonical =
          activity.type === "reply" && push
            ? canonicalReplyEvent(activity, push.serverId)
            : activity.type === "reply"
              ? {
                  ...activity,
                  eventId: activity.executionId,
                  serverId: "",
                  entryId: activity.entryId ?? null,
                }
              : data;

        if (!stream.aborted)
          stream
            .writeSSE({ event: "activity", data: JSON.stringify(canonical) })
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

  register(routes.agentMemories, (c) => {
    service.agent(c.req.param("id"));

    return c.json(store.listMemories(c.req.param("id")), 200);
  });
  register(routes.createAgentMemory, async (c) => {
    service.agent(c.req.param("id"));
    const input = memoryInput.parse(await c.req.json());

    return c.json(
      store.createMemory({
        agentId: c.req.param("id"),
        content: input.content,
      }),
      201,
    );
  });
  register(routes.updateAgentMemory, async (c) => {
    const memory = store.getMemory(c.req.param("memoryId"));

    if (!memory || memory.agentId !== c.req.param("id"))
      throw new AppError(404, "Memory not found");

    return c.json(
      store.updateMemory(memory.id, memoryInput.parse(await c.req.json())),
      200,
    );
  });
  register(routes.deleteAgentMemory, (c) => {
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

  register(routes.memories, (c) => c.json(store.listMemories(null), 200));
  register(routes.createMemory, async (c) => {
    const input = memoryInput.parse(await c.req.json());

    return c.json(
      store.createMemory({ agentId: null, content: input.content }),
      201,
    );
  });
  register(routes.updateMemory, async (c) => {
    const memory = sharedMemory(c.req.param("id"));

    return c.json(
      store.updateMemory(memory.id, memoryInput.parse(await c.req.json())),
      200,
    );
  });
  register(routes.deleteMemory, (c) => {
    store.deleteMemory(sharedMemory(c.req.param("id")).id);

    return c.body(null, 204);
  });
  register(routes.skills, (c) =>
    c.json(
      [
        ...(options.commonSkills ?? []).map(
          ({ id, name, description, instructions, path }) => {
            const skill = {
              id,
              name,
              description,
              instructions,
              path,
              source: "bundled" as const,
            };

            return skill;
          },
        ),
        ...store
          .listSkills()
          .map((skill) => ({ ...skill, source: "shared" as const })),
      ],
      200,
    ),
  );
  register(routes.createSkill, async (c) =>
    c.json(store.createSkill(skillInput.parse(await c.req.json())), 201),
  );
  register(routes.updateSkill, async (c) => {
    if (options.commonSkills?.some((skill) => skill.id === c.req.param("id")))
      throw new AppError(405, "Bundled skills are read-only");
    const old = store.getSkill(c.req.param("id"));

    if (!old) throw new AppError(404, "Skill not found");

    return c.json(
      store.updateSkill(
        old.id,
        skillInput.parse({ ...old, ...(await c.req.json()) }),
      ),
      200,
    );
  });
  register(routes.deleteSkill, (c) => {
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
  register(routes.schedules, (c) =>
    c.json(store.listSchedules(c.req.query("agentId")), 200),
  );
  register(routes.createSchedule, async (c) =>
    c.json(
      await scheduler.create(scheduleInput.parse(await c.req.json())),
      201,
    ),
  );
  register(routes.updateSchedule, async (c) => {
    const old = store.getSchedule(c.req.param("id"));

    if (!old) throw new AppError(404, "Schedule not found");

    return c.json(
      await scheduler.update(
        old.id,
        scheduleInput.parse({ ...old, ...(await c.req.json()) }),
      ),
      200,
    );
  });
  register(routes.deleteSchedule, (c) => {
    if (!store.deleteSchedule(c.req.param("id")))
      throw new AppError(404, "Schedule not found");

    return c.body(null, 204);
  });
  register(routes.runSchedule, async (c) => {
    const run = await scheduler.runNow(c.req.param("id"));

    return c.json({ ...run, result: run.result ?? undefined }, 202);
  });
  register(routes.executions, (c) =>
    c.json(store.listExecutions(c.req.query("agentId")), 200),
  );
  register(routes.activity, async (c) => {
    const input = activityInput.parse(c.req.query());

    const agents = input.agentId
      ? [service.agent(input.agentId)]
      : store.listAgents();

    // History is durable per agent; skip bots that have never opened a conversation so
    // this read-only feed does not initialize empty chats.
    const existing = agents.filter(
      (agent) => store.listConversations(agent.id, true).length,
    );

    const histories: {
      agent: (typeof existing)[number];
      messages: TranscriptMessage[];
    }[] = [];

    let historyHasMore = false;

    for (const agent of existing) {
      let before: string | undefined;
      const collected: TranscriptMessage[] = [];
      let pageHasMore = false;

      // Walk a bounded number of pages so a text-heavy transcript does not hide
      // older operational events while keeping this feed a cheap read.
      for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
        const historyOptions = {
          limit: 200,
          includeActiveAssistant: true,
          before,
        };

        const page = await runtime.history(agent, historyOptions);

        collected.push(...page.messages);
        pageHasMore = Boolean(page.hasMore);

        if (!page.hasMore || !page.oldestEntryId) break;

        if (operationalActivity(agent, collected).length >= input.limit) break;
        before = page.oldestEntryId;
      }

      historyHasMore ||= pageHasMore;
      histories.push({ agent, messages: collected });
    }

    const activities = sortActivity(
      histories.flatMap(({ agent, messages }) =>
        operationalActivity(agent, messages),
      ),
    );

    const feed: z.output<typeof activityFeedResponse> = {
      activities: activities.slice(0, input.limit),
      hasMore: activities.length > input.limit || historyHasMore,
    };

    return c.json(feed, 200);
  });

  const authenticatedModels = providerModels((name) =>
    store.getCredential(name),
  );

  register(routes.providers, async (c) =>
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
      200,
    ),
  );

  // Dynamic providers list their models only after a refresh with the saved key.
  const refreshed = async (name: string | undefined) => {
    await authenticatedModels.refresh(name ? { providers: [name] } : {});

    return authenticatedModels.getModels(name);
  };

  register(routes.models, async (c) => {
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
      200,
    );
  });
  register(routes.putProvider, async (c) => {
    const name = provider.parse(c.req.param("provider"));

    const input = providerKeyInput.parse(await c.req.json());

    store.setCredential(name, input.apiKey);

    return c.json({ provider: name, configured: true }, 200);
  });
  register(routes.deleteProvider, (c) => {
    store.deleteCredential(provider.parse(c.req.param("provider")));

    return c.body(null, 204);
  });

  const describeServer = (server: MCPServer) => {
    const auth = hasOAuthTokens(store, server.id)
      ? "oauth"
      : store.getCredential(`mcp:${server.id}`)
        ? "token"
        : "none";

    return { ...server, auth, authenticated: auth !== "none" } as const;
  };

  const mcpServer = (id: string) => {
    const server = store.getMCPServer(id);

    if (!server) throw new AppError(404, "MCP server not found");

    return server;
  };

  register(routes.mcpServers, (c) =>
    c.json(store.listMCPServers().map(describeServer), 200),
  );
  // OAuth sign-in: the client opens the returned URL, then posts back the code, state and issuer it receives.
  register(routes.oauth, async (c) => {
    const { redirectUri } = oauthInput.parse(await c.req.json());

    return c.json(
      await startAuthorization(
        store,
        mcpServer(c.req.param("id")),
        redirectUri,
      ),
      200,
    );
  });
  register(routes.oauthCallback, async (c) => {
    const { code, state, iss } = oauthCallbackInput.parse(await c.req.json());

    const server = mcpServer(c.req.param("id"));
    await finishAuthorization(store, server, code, state, iss);
    await integrations?.disconnect(server.id);

    return c.json(describeServer(server), 200);
  });
  register(routes.deleteOauth, async (c) => {
    const server = mcpServer(c.req.param("id"));
    signOut(store, server.id);
    await integrations?.disconnect(server.id);

    return c.json(describeServer(server), 200);
  });

  // A server added with `agentId` belongs to that bot, which starts using it right away.
  register(routes.createMcpServer, async (c) => {
    const input = mcpCreateInput.parse(await c.req.json());

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
  register(routes.updateMcpServer, async (c) => {
    const old = store.getMCPServer(c.req.param("id"));

    if (!old) throw new AppError(404, "MCP server not found");
    const input = mcpInput.parse({ ...old, ...(await c.req.json()) });

    if (input.token !== undefined) {
      if (input.token) store.setCredential(`mcp:${old.id}`, input.token);
      else store.deleteCredential(`mcp:${old.id}`);
    }

    return c.json(store.updateMCPServer(old.id, input), 200);
  });
  register(routes.deleteMcpServer, (c) => {
    if (!store.deleteMCPServer(c.req.param("id")))
      throw new AppError(404, "MCP server not found");
    store.deleteCredential(`mcp:${c.req.param("id")}`);
    signOut(store, c.req.param("id"));

    return c.body(null, 204);
  });

  return app;
}
