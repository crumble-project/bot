import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  routes,
  contractApp,
  memoryInput,
  credentialUsesInput,
  snapshotInput,
  historyInput,
  messageInput,
  activityInput,
  providerKeyInput,
  providerLoginInput,
  providerLoginAnswerInput,
  oauthInput,
  oauthCallbackInput,
  mcpInput,
  mcpCreateInput,
  attachmentIndex,
  groupMessageInput,
  changesInput,
  patchInput,
  reviewsInput,
} from "../contract/api-contract";
import { bearerAuth } from "hono/bearer-auth";
import { registerDesktopRoutes } from "../bot-desktop/desktop-api";
import {
  desktopControlAccess,
  type DesktopControlAccess,
} from "../bot-desktop/desktop-control";
import { ViewerTickets } from "../bot-desktop/desktop-viewer";
import type { DesktopStream } from "../workspaces/workspace";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { Effect } from "effect";
import type {
  activityFeedResponse,
  chatSnapshotResponse,
  codingJobsResponse,
  desktopJobsResponse,
  scheduleRunResponse,
} from "../contract/api-responses";
import {
  agentInput,
  scheduleInput,
  skillInput,
  skillLifecycleInput,
  groupChatInput,
  credentialSaveInput,
  AppError,
  type MCPServer,
} from "../shared/domain";
import type { CrumbleService } from "../bots/service";
import type { Activity } from "../bots/service";
import type { Scheduler } from "../schedules/scheduler";
import type { GroupChats } from "../group-chats/group-chats";
import type { MCPIntegrations } from "../integrations/integrations";
import { providerModels } from "../providers/providers";
import { ProviderCredentials } from "../providers/provider-credentials";
import { Credentials } from "../credentials/credentials";
import { loginMethods, ProviderAuth } from "../providers/provider-auth";
import type { CommonSkill } from "../skills/common-skills";
import {
  CLIENT_DOCUMENT_PATH,
  clientSecretKey,
  type ClientDocument,
  clientDocumentBody,
  finishAuthorization,
  hasOAuthTokens,
  signOut,
  startAuthorization,
} from "../integrations/mcp-oauth";
import type { ExternalAuth } from "./plugins";
import { MAX_MESSAGE_BODY } from "../shared/attachments";
import { activityPage, decodeCursor } from "../activity/activity";
import { Push, type PushRuntime } from "../push/push";
import { canonicalReplyEvent } from "../push/push-model";
import { registerPushRoutes } from "../push/push-api";

export function createAPI(
  service: CrumbleService,
  scheduler: Scheduler,
  token: string,
  integrations?: MCPIntegrations,
  options: {
    commonSkills?: CommonSkill[];
    /** Whether the server can give bots the coding tool. */
    coding?: boolean;
    /** Whether the server can give bots the desktop tool. */
    desktop?: boolean;
    /** Stops a bot's workspace machine, so its next use boots the image its tools need now. */
    restartWorkspace?: (agentId: string) => Promise<void>;
    /** Group chats; their routes answer 503 without it. */
    groupChats?: GroupChats;
    /** Who operates each bot desktop. */
    desktopControl?: DesktopControlAccess;
    /** Single-use viewer links. */
    viewerTickets?: ViewerTickets;
    /** Connects to a bot desktop's VNC server, for viewers. */
    openDesktop?: (agentId: string) => Promise<DesktopStream>;
    /** Boots a bot's machine ahead of a viewer's connection. */
    startDesktop?: (agentId: string) => Promise<void>;
    /** The server's provider sign-ins; API-only fixtures get one of their own. */
    providerAuth?: ProviderAuth;
    /** The server's OAuth client metadata document, when it has a public address. */
    oauthClient?: ClientDocument | undefined;
    /** Providers whose sign-in happens outside Crumble, by provider ID. */
    externalAuth?: ReadonlyMap<string, () => Promise<ExternalAuth>>;
    /** The bots' credentials; API-only fixtures get their own. */
    credentials?: Credentials;
  } = {},
  push?: PushRuntime,
) {
  if (token.length < 32)
    throw new Error("Server token must contain at least 32 characters");
  const { store, runtime } = service;
  const app = contractApp();

  const credentials =
    options.credentials ??
    new Credentials(store, async (agentId, text, requestId) => {
      await service.notice(agentId, text, requestId);
    });

  const providerAuth =
    options.providerAuth ??
    (() => {
      const credentials = new ProviderCredentials(store);

      return new ProviderAuth(store, credentials, providerModels(credentials));
    })();

  const models = providerAuth.models;

  const provider = z
    .string()
    .refine((value) => Boolean(models.getProvider(value)), "Unknown provider");

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
    /^\/v1\/(agents|group-chats)\/[^/]+\/messages$/.test(c.req.path)
      ? messageBodyLimit(c, next)
      : defaultBodyLimit(c, next),
  );
  register(routes.health, (c) =>
    c.json({ status: "ok", apiVersion: 1 } as const, 200),
  );
  // Public like /health: authorization servers fetch it to identify Crumble as an OAuth client.
  app.get(CLIENT_DOCUMENT_PATH, (c) =>
    options.oauthClient
      ? c.json(clientDocumentBody(options.oauthClient), 200, {
          "Cache-Control": "public, max-age=3600",
        })
      : c.notFound(),
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

  registerDesktopRoutes({
    app,
    register,
    service,
    desktop: options.desktop === true,
    control: options.desktopControl ?? desktopControlAccess(store.runtime),
    tickets: options.viewerTickets ?? new ViewerTickets(),
    ...(options.openDesktop && { openDesktop: options.openDesktop }),
    ...(options.startDesktop && { startDesktop: options.startDesktop }),
  });
  register(routes.capabilities, (c) =>
    c.json(
      { coding: options.coding === true, desktop: options.desktop === true },
      200,
    ),
  );
  registerPushRoutes(register, push);

  const pushServerId = push?.runSync(
    Push.use((service) => Effect.succeed(service.serverId)),
  );

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
    const body = patchInput(agentInput).parse(await c.req.json());

    // The inline skills are a view of the bot's packages, which may outgrow the inline limit; only a submitted list is validated.
    const { skills, ...input } = agentInput.parse({
      ...old,
      ...body,
      skills: body["skills"] ?? [],
    });

    provider.parse(input.provider);
    checkServers(old.id, input.mcpServers);

    if (!input.enabled && old.enabled)
      for (const conversation of store.listConversations(old.id))
        await service.abort(conversation.id);

    const updated = store.updateAgent(
      old.id,
      body["skills"] ? { ...input, skills } : input,
    );

    // The desktop tool picks the workspace image; a bot that gains or loses it needs a fresh boot.
    if (old.tools.includes("desktop") !== input.tools.includes("desktop"))
      await options.restartWorkspace?.(old.id);

    return c.json(updated, 200);
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
  register(routes.codingJobs, async (c) => {
    const jobs: z.output<typeof codingJobsResponse> = {
      jobs: await service.codingJobs(c.req.param("id")),
    };

    return c.json(jobs, 200);
  });
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
  register(routes.desktopJobs, async (c) => {
    const jobs: z.output<typeof desktopJobsResponse> = {
      jobs: await service.desktopJobs(c.req.param("id")),
    };

    return c.json(jobs, 200);
  });
  register(routes.desktopJobHistory, async (c) =>
    c.json(
      await service.desktopJobHistory(
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

      const send = (data: Activity) => {
        const activity = data;

        const canonical =
          activity.type === "reply" && pushServerId !== undefined
            ? canonicalReplyEvent(activity, pushServerId)
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
            .writeSSE({
              event: data.type === "learned" ? "learned" : "activity",
              data: JSON.stringify(canonical),
            })
            .catch(finish);
      };

      const unsubscribers = [service.onActivity(send)];

      // Browsers see the response only once a body chunk arrives, which without bots to preview could take 15 seconds.
      await stream.writeSSE({ event: "heartbeat", data: "{}" });

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

  const groupChats = () => {
    if (!options.groupChats)
      throw new AppError(503, "Group chats are unavailable");

    return options.groupChats;
  };

  register(routes.listGroupChats, (c) => c.json(groupChats().list(), 200));
  register(routes.createGroupChat, async (c) =>
    c.json(groupChats().create(groupChatInput.parse(await c.req.json())), 201),
  );
  register(routes.getGroupChat, (c) =>
    c.json(groupChats().get(c.req.param("id")), 200),
  );
  register(routes.updateGroupChat, async (c) => {
    const current = groupChats().get(c.req.param("id"));

    // Merge before validation, as agent updates do.
    const input = groupChatInput.parse({
      name: current.name,
      memberIds: current.memberIds,
      ...(await c.req.json()),
    });

    return c.json(await groupChats().update(current.id, input), 200);
  });
  register(routes.deleteGroupChat, async (c) => {
    await groupChats().delete(c.req.param("id"));

    return c.body(null, 204);
  });
  register(routes.groupChatSnapshot, async (c) =>
    c.json(
      await groupChats().snapshot(c.req.param("id"), snapshotQuery(c)),
      200,
    ),
  );
  register(routes.groupChatHistory, async (c) =>
    c.json(
      await groupChats().history(
        c.req.param("id"),
        historyInput.parse(c.req.query()),
      ),
      200,
    ),
  );
  register(routes.sendGroupMessage, async (c) => {
    const input = groupMessageInput.parse(await c.req.json());

    return c.json(
      await groupChats().post(
        c.req.param("id"),
        input.content,
        input.requestId,
        { replyTo: input.replyTo, attachments: input.attachments },
      ),
      201,
    );
  });
  register(routes.groupAttachment, async (c) => {
    const index = attachmentIndex.parse(c.req.param("index"));

    const file = await groupChats().attachment(
      c.req.param("id"),
      c.req.param("entryId"),
      index,
    );

    return c.body(new Uint8Array(file.data), 200, {
      "Content-Type": file.mimeType,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });
  register(routes.stopGroupChat, async (c) => {
    await groupChats().stop(c.req.param("id"));

    return c.body(null, 204);
  });
  register(routes.groupChatEvents, async (c) => {
    const query = snapshotQuery(c);
    const groups = groupChats();
    const groupId = groups.get(c.req.param("id")).id;

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
            data: JSON.stringify(await groups.snapshot(groupId, query)),
          });
      };

      // A deleted group fails its next snapshot, which ends the stream.
      const unsubscribe = groups.subscribe(groupId, () => {
        void sendSnapshot().catch(finish);
      });

      const timer = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(finish);
      }, 15000);

      try {
        await sendSnapshot();
        await finished;
      } finally {
        clearInterval(timer);
        unsubscribe();
      }
    });
  });

  register(routes.agentCredentials, (c) => {
    service.agent(c.req.param("id"));

    return c.json(credentials.list(c.req.param("id")), 200);
  });
  register(routes.saveAgentCredential, async (c) => {
    service.agent(c.req.param("id"));
    const input = credentialSaveInput.parse(await c.req.json());

    return c.json(
      await credentials.save(c.req.param("id"), c.req.param("name"), input),
      200,
    );
  });
  register(routes.deleteAgentCredential, async (c) => {
    service.agent(c.req.param("id"));
    await credentials.delete(c.req.param("id"), c.req.param("name"));

    return c.body(null, 204);
  });
  register(routes.agentCredentialUses, (c) => {
    service.agent(c.req.param("id"));
    const query = credentialUsesInput.parse(c.req.query());

    return c.json(
      credentials.uses(c.req.param("id"), c.req.param("name"), query),
      200,
    );
  });
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
        source: { kind: "owner" },
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
      store.createMemory({
        agentId: null,
        content: input.content,
        source: { kind: "owner" },
      }),
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

  const agentSkill = (agentId: string, skillId: string) => {
    const skill = store.getSkill(skillId);

    if (!skill || skill.agentId !== agentId)
      throw new AppError(404, "Skill not found");

    return skill;
  };

  register(routes.agentSkills, (c) =>
    c.json(store.listSkills(service.agent(c.req.param("id")).id), 200),
  );
  register(routes.createAgentSkill, async (c) =>
    c.json(
      store.createSkill({
        ...skillInput.parse(await c.req.json()),
        agentId: service.agent(c.req.param("id")).id,
      }),
      201,
    ),
  );
  register(routes.updateAgentSkill, async (c) => {
    const old = agentSkill(
      service.agent(c.req.param("id")).id,
      c.req.param("skillId"),
    );

    const body = await c.req.json();
    const lifecycle = skillLifecycleInput.parse(body);

    return c.json(
      store.updateSkill(old.id, {
        ...skillInput.parse({ ...old, ...body }),
        ...(lifecycle.state && { state: lifecycle.state }),
        ...(lifecycle.pinned !== undefined && { pinned: lifecycle.pinned }),
      }),
      200,
    );
  });
  register(routes.deleteAgentSkill, (c) => {
    store.deleteSkill(
      agentSkill(service.agent(c.req.param("id")).id, c.req.param("skillId"))
        .id,
    );

    return c.body(null, 204);
  });
  register(routes.agentReviews, (c) =>
    c.json(
      store.listReviewResults(
        service.agent(c.req.param("id")).id,
        reviewsInput.parse(c.req.query()).limit,
      ),
      200,
    ),
  );
  register(routes.changes, (c) => {
    const query = changesInput.parse(c.req.query());

    if (query.agentId && query.agentId !== "shared")
      service.agent(query.agentId);

    return c.json(
      store.listChanges(query.agentId === "shared" ? null : query.agentId, {
        limit: query.limit,
        before: query.before,
      }),
      200,
    );
  });
  register(routes.revertChange, (c) => {
    const reverted = store.revertChange(c.req.param("id"), {
      actor: "owner",
    });

    if (!reverted) throw new AppError(404, "Change not found");

    return c.json(reverted, 201);
  });
  register(routes.skills, (c) =>
    c.json(
      [
        ...(options.commonSkills ?? []).map(
          ({ id, name, description, instructions, documents, path }) => ({
            id,
            name,
            description,
            instructions,
            documents,
            path,
            source: "bundled" as const,
          }),
        ),
        ...store
          .listSkills(null)
          .map((skill) => ({ ...skill, source: "shared" as const })),
      ],
      200,
    ),
  );
  register(routes.getSkill, (c) => {
    const skill = store.getSkill(c.req.param("id"));

    if (!skill || skill.agentId) throw new AppError(404, "Skill not found");

    return c.json(skill, 200);
  });
  register(routes.createSkill, async (c) =>
    c.json(store.createSkill(skillInput.parse(await c.req.json())), 201),
  );
  register(routes.updateSkill, async (c) => {
    if (options.commonSkills?.some((skill) => skill.id === c.req.param("id")))
      throw new AppError(405, "Bundled skills are read-only");
    const old = store.getSkill(c.req.param("id"));

    if (!old || old.agentId) throw new AppError(404, "Skill not found");

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

    if (store.getSkill(skillId)?.agentId || !store.deleteSkill(skillId))
      throw new AppError(404, "Skill not found");

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
    c.json(scheduler.create(scheduleInput.parse(await c.req.json())), 201),
  );
  register(routes.updateSchedule, async (c) => {
    const old = store.getSchedule(c.req.param("id"));

    if (!old) throw new AppError(404, "Schedule not found");

    return c.json(
      scheduler.update(
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

    const body: z.output<typeof scheduleRunResponse> = {
      ...run,
      result: run.result ?? undefined,
    };

    return c.json(body, 202);
  });
  register(routes.executions, (c) =>
    c.json(store.listExecutions(c.req.query("agentId")), 200),
  );
  register(routes.activity, async (c) => {
    const input = activityInput.parse(c.req.query());
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;

    if (input.cursor && !cursor) throw new AppError(400, "Invalid cursor");

    const agents = input.agentId
      ? [service.agent(input.agentId)]
      : store.listAgents();

    const feed: z.output<typeof activityFeedResponse> = await activityPage({
      // History is durable per agent; skip bots that have never opened a conversation so
      // this read-only feed does not initialize empty chats.
      agents: agents.filter(
        (agent) => store.listConversations(agent.id, true).length,
      ),
      history: (agent, before, limit) =>
        runtime.history(agent, {
          limit,
          before,
          includeActiveAssistant: true,
        }),
      changes: (limit, before) =>
        store.listChanges(input.agentId, { limit, before }),
      agentName: (id) => store.getAgent(id)?.name ?? null,
      limit: input.limit,
      cursor,
      kind: input.kind,
    });

    return c.json(feed, 200);
  });

  register(routes.providers, async (c) => {
    const saved = new Map(
      store
        .listProviderCredentials()
        .map((info) => [info.providerId, info.type]),
    );

    return c.json(
      await Promise.all(
        models.getProviders().map(async (item) => ({
          provider: item.id,
          name: item.name,
          configured: Boolean(
            await models.checkAuth(item.id).catch(() => undefined),
          ),
          authMethods: loginMethods(item),
          credentialType: saved.get(item.id) ?? null,
          activeLoginId: providerAuth.activeLoginId(item.id),
          externalAuth: (await options.externalAuth?.get(item.id)?.()) ?? null,
        })),
      ),
      200,
    );
  });

  // Dynamic providers list their models only after a refresh with the saved credential.
  const available = async (name: string | undefined) => {
    await models.refresh(name ? { providers: [name] } : {});

    try {
      return await models.getAvailable(name);
    } catch {
      // Pi AI errors can carry provider responses; keep them out of logs and clients.
      throw new AppError(503, "Provider credentials could not be read");
    }
  };

  register(routes.models, async (c) => {
    const name = c.req.query("provider");

    if (name) provider.parse(name);

    return c.json(
      (await available(name)).map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
        thinkingLevels: getSupportedThinkingLevels(model),
      })),
      200,
    );
  });
  register(routes.putProvider, async (c) => {
    const name = provider.parse(c.req.param("provider"));

    const input = providerKeyInput.parse(await c.req.json());

    await providerAuth.setApiKey(name, input.apiKey);

    return c.json({ provider: name, configured: true }, 200);
  });
  register(routes.deleteProvider, async (c) => {
    const name = provider.parse(c.req.param("provider"));
    const external = await options.externalAuth?.get(name)?.();

    if (external)
      throw new AppError(
        409,
        `This provider signs in outside Crumble. Sign out on the server: ${external.signOutCommand ?? "see its documentation"}`,
      );

    await providerAuth.signOut(name);

    return c.body(null, 204);
  });
  register(routes.startProviderLogin, async (c) => {
    const name = c.req.param("provider");

    if (!models.getProvider(name)) throw new AppError(404, "Unknown provider");
    const input = providerLoginInput.parse(await c.req.json());

    return c.json(providerAuth.start(name, input.method), 202);
  });
  register(routes.getProviderLogin, (c) =>
    c.json(providerAuth.get(c.req.param("id")), 200),
  );
  register(routes.answerProviderLogin, async (c) => {
    const input = providerLoginAnswerInput.safeParse(await c.req.json());

    // Answers can be secrets or callback URLs; never echo them in validation details.
    if (!input.success) throw new AppError(400, "Invalid answer");

    return c.json(
      providerAuth.answer(
        c.req.param("id"),
        input.data.promptId,
        input.data.value,
      ),
      200,
    );
  });
  register(routes.cancelProviderLogin, (c) =>
    c.json(providerAuth.cancel(c.req.param("id")), 200),
  );

  const describeServer = (server: MCPServer) => {
    const auth = hasOAuthTokens(store, server.id)
      ? "oauth"
      : store.getCredential(`mcp:${server.id}`)
        ? "token"
        : "none";

    return {
      ...server,
      auth,
      authenticated: auth !== "none",
      error: integrations?.failure(server.id) ?? null,
      hasOAuthClientSecret: Boolean(
        store.getCredential(clientSecretKey(server.id)),
      ),
    } as const;
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
        options.oauthClient,
      ),
      200,
    );
  });
  register(routes.oauthCallback, async (c) => {
    const { code, state, iss } = oauthCallbackInput.parse(await c.req.json());

    const server = mcpServer(c.req.param("id"));
    await finishAuthorization(
      store,
      server,
      code,
      state,
      iss,
      options.oauthClient,
    );
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

    if (input.oauthClientSecret)
      store.setCredential(clientSecretKey(server.id), input.oauthClientSecret);

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

    const secretChanged =
      input.oauthClientSecret !== undefined &&
      input.oauthClientSecret !== store.getCredential(clientSecretKey(old.id));

    if (input.oauthClientSecret !== undefined) {
      if (input.oauthClientSecret)
        store.setCredential(clientSecretKey(old.id), input.oauthClientSecret);
      else store.deleteCredential(clientSecretKey(old.id));
    }

    // Tokens belong to the client that obtained them, so another client signs in again.
    if (secretChanged || (input.oauthClientId ?? null) !== old.oauthClientId) {
      signOut(store, old.id);
      await integrations?.disconnect(old.id);
    }

    return c.json(
      store.updateMCPServer(old.id, {
        ...input,
        oauthClientId: input.oauthClientId ?? null,
      }),
      200,
    );
  });
  register(routes.deleteMcpServer, (c) => {
    if (!store.deleteMCPServer(c.req.param("id")))
      throw new AppError(404, "MCP server not found");
    store.deleteCredential(`mcp:${c.req.param("id")}`);
    store.deleteCredential(clientSecretKey(c.req.param("id")));
    signOut(store, c.req.param("id"));

    return c.body(null, 204);
  });

  return app;
}
