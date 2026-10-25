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
import type { DesktopOpenError } from "../workspaces/workspace-errors";
import { bodyLimit } from "hono/body-limit";
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
  type MCPServer,
} from "../shared/domain";
import type { Activity, BotsAccess } from "../bots/bots";
import type { AgentRuntime } from "../bots/runtime";
import type { CoreServices } from "../shared/core-layer";
import type { Runner } from "../shared/runner";
import { AgentRepository } from "../bots/agent-repository";
import { ConversationRepository } from "../bots/conversation-repository";
import { ExecutionRepository } from "../bots/execution-repository";
import { SecretRepository } from "../credentials/secret-repository";
import { McpServerRepository } from "../integrations/mcp-server-repository";
import { MemoryRepository } from "../memory/memory-repository";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { ChangeReverter } from "../skills/change-reverter";
import { LearnedChangeRepository } from "../skills/learned-change-repository";
import { SkillRepository } from "../skills/skill-repository";
import { ProviderCredentialRepository } from "../providers/provider-credential-repository";
import type { SchedulerAccess } from "../schedules/scheduler";
import type { GroupChatsAccess } from "../group-chats/group-chats";
import type { McpIntegrations } from "../integrations/integrations";
import {
  credentialsAccess,
  type CredentialsAccess,
} from "../credentials/credentials";
import {
  loginMethods,
  standaloneSignIns,
  type ProviderSignInsAccess,
} from "../providers/provider-auth";
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
  secretStorage,
} from "../integrations/mcp-oauth";
import type { ExternalAuth } from "./plugins";
import { sendHeartbeat, snapshotSender, streamEvents } from "./event-stream";
import { MAX_MESSAGE_BODY } from "../shared/attachments";
import { activityPage, decodeCursor } from "../activity/activity";
import { Push, type PushRuntime } from "../push/push";
import { canonicalReplyEvent } from "../push/push-model";
import { registerPushRoutes } from "../push/push-api";
import {
  InvalidInput,
  NotFound,
  ReadOnly,
  Conflict,
  Unavailable,
  httpStatus,
  isAppError,
} from "../shared/errors";

/** The bots the API serves, with the account's repositories and bot runtime its handlers read directly. */
export type ApiBots = BotsAccess & {
  core: Runner<CoreServices>;
  runtime: AgentRuntime;
};

export function createAPI(
  service: ApiBots,
  scheduler: SchedulerAccess,
  token: string,
  integrations?: McpIntegrations["Service"],
  options: {
    commonSkills?: CommonSkill[];
    /** Whether the server can give bots the coding tool. */
    coding?: boolean;
    /** Whether the server can give bots the desktop tool. */
    desktop?: boolean;
    /** Stops a bot's workspace machine, so its next use boots the image its tools need now. */
    restartWorkspace?: (agentId: string) => Promise<void>;
    /** Group chats; their routes answer 503 without it. */
    groupChats?: GroupChatsAccess;
    /** Who operates each bot desktop. */
    desktopControl?: DesktopControlAccess;
    /** Single-use viewer links. */
    viewerTickets?: ViewerTickets;
    /** Connects to a bot desktop's VNC server, for viewers. */
    openDesktop?: (
      agentId: string,
    ) => Effect.Effect<DesktopStream, DesktopOpenError>;
    /** Boots a bot's machine ahead of a viewer's connection. */
    startDesktop?: (agentId: string) => Effect.Effect<void, DesktopOpenError>;
    /** The server's provider sign-ins; API-only fixtures get one of their own. */
    providerAuth?: ProviderSignInsAccess;
    /** The server's OAuth client metadata document, when it has a public address. */
    oauthClient?: ClientDocument | undefined;
    /** Providers whose sign-in happens outside Crumble, by provider ID. */
    externalAuth?: ReadonlyMap<string, () => Promise<ExternalAuth>>;
    /** The bots' credentials; API-only fixtures get their own. */
    credentials?: CredentialsAccess;
  } = {},
  push?: PushRuntime,
) {
  if (token.length < 32)
    throw new Error("Server token must contain at least 32 characters");
  const { core, runtime } = service;

  const exec = <A>(effect: Effect.Effect<A, never, CoreServices>) =>
    core.runSync(effect);

  const app = contractApp();

  const credentials = options.credentials ?? credentialsAccess(core);
  const secrets = secretStorage(core);

  const providerAuth = options.providerAuth ?? standaloneSignIns(core);

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

    if (isAppError(error))
      return c.json({ error: error.message }, httpStatus(error));

    if (error instanceof SyntaxError)
      return c.json({ error: "Invalid JSON" }, 400);
    console.error(error);

    return c.json({ error: "The server could not complete this request" }, 500);
  });

  registerDesktopRoutes({
    app,
    register,
    service,
    run: core,
    desktop: options.desktop === true,
    control: options.desktopControl ?? desktopControlAccess(core),
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
      const owner = exec(
        McpServerRepository.use((r) => r.get(serverId)),
      )?.agentId;

      if (owner && owner !== agentId)
        throw new InvalidInput({
          message: "That MCP server belongs to another bot",
        });
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

    return c.json(exec(AgentRepository.use((r) => r.create(input))), 201);
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
      for (const conversation of exec(
        ConversationRepository.use((r) => r.list(old.id)),
      ))
        await service.abort(conversation.id);

    const updated = exec(
      AgentRepository.use((r) =>
        r.update(old.id, body["skills"] ? { ...input, skills } : input),
      ),
    );

    // The desktop tool picks the workspace image; a bot that gains or loses it needs a fresh boot.
    if (old.tools.includes("desktop") !== input.tools.includes("desktop"))
      await options.restartWorkspace?.(old.id);

    return c.json(updated, 200);
  });
  register(routes.duplicateAgent, (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      exec(AgentRepository.use((r) => r.duplicate(c.req.param("id")))),
      201,
    );
  });
  register(routes.deleteAgent, async (c) => {
    const personal = exec(McpServerRepository.use((r) => r.list)).filter(
      (server) => server.agentId === c.req.param("id"),
    );

    await service.deleteAgent(c.req.param("id"));

    // The bot's personal servers went with it; their credentials and connections go too.
    for (const server of personal) {
      exec(SecretRepository.use((r) => r.delete(`mcp:${server.id}`)));
      signOut(secrets, server.id);

      if (integrations)
        await Effect.runPromise(integrations.disconnect(server.id));
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

    return streamEvents(c, async ({ stream, close, onClose }) => {
      const sendSnapshot = snapshotSender(stream, () =>
        service.snapshot(chat.id, options),
      );

      onClose(
        service.subscribe(chat.id, () => {
          void sendSnapshot().catch(close);
        }),
      );
      onClose(await runtime.watch(agent, chat.id, sendSnapshot, options));
    });
  });

  // Server-wide activity for notifications: finished replies from every bot.
  register(routes.events, (c) =>
    streamEvents(c, async ({ stream, close, onClose }) => {
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
            .catch(close);
      };

      onClose(service.onActivity(send));

      // Without bots to preview, the first activity could take 15 seconds to arrive.
      await sendHeartbeat(stream);

      // Replay current previews on every connection so a sidebar can recover missed events.
      for (const { agent, lastMessage } of await service.agentPreviews())
        send({
          type: "chat-preview",
          agentId: agent.id,
          agentName: agent.name,
          lastMessage,
        });
    }),
  );

  const groupChats = () => {
    if (!options.groupChats)
      throw new Unavailable({ message: "Group chats are unavailable" });

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

    return streamEvents(c, async ({ stream, close, onClose }) => {
      const sendSnapshot = snapshotSender(stream, () =>
        groups.snapshot(groupId, query),
      );

      // A deleted group fails its next snapshot, which ends the stream.
      onClose(
        groups.subscribe(groupId, () => {
          void sendSnapshot().catch(close);
        }),
      );

      await sendSnapshot();
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

    return c.json(
      exec(MemoryRepository.use((r) => r.list(c.req.param("id")))),
      200,
    );
  });

  /** The memory, which must belong to the bot or, with `null`, to every bot. */
  const memoryOf = (agentId: string | null, memoryId: string) => {
    const memory = exec(MemoryRepository.use((r) => r.get(memoryId)));

    if (!memory || memory.agentId !== agentId)
      throw new NotFound({ message: "Memory not found" });

    return memory;
  };

  const createMemory = (
    agentId: string | null,
    input: z.output<typeof memoryInput>,
  ) =>
    exec(
      MemoryRepository.use((r) =>
        r.create({
          agentId,
          content: input.content,
          source: { kind: "owner" },
        }),
      ),
    );

  const updateMemory = (
    memoryId: string,
    input: z.output<typeof memoryInput>,
  ) => exec(MemoryRepository.use((r) => r.update(memoryId, input)));

  const deleteMemory = (memoryId: string) =>
    exec(MemoryRepository.use((r) => r.delete(memoryId)));

  register(routes.createAgentMemory, async (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      createMemory(c.req.param("id"), memoryInput.parse(await c.req.json())),
      201,
    );
  });
  register(routes.updateAgentMemory, async (c) => {
    const memory = memoryOf(c.req.param("id"), c.req.param("memoryId"));

    return c.json(
      updateMemory(memory.id, memoryInput.parse(await c.req.json())),
      200,
    );
  });
  register(routes.deleteAgentMemory, (c) => {
    deleteMemory(memoryOf(c.req.param("id"), c.req.param("memoryId")).id);

    return c.body(null, 204);
  });

  register(routes.memories, (c) =>
    c.json(exec(MemoryRepository.use((r) => r.list(null))), 200),
  );
  register(routes.createMemory, async (c) =>
    c.json(createMemory(null, memoryInput.parse(await c.req.json())), 201),
  );
  register(routes.updateMemory, async (c) => {
    const memory = memoryOf(null, c.req.param("id"));

    return c.json(
      updateMemory(memory.id, memoryInput.parse(await c.req.json())),
      200,
    );
  });
  register(routes.deleteMemory, (c) => {
    deleteMemory(memoryOf(null, c.req.param("id")).id);

    return c.body(null, 204);
  });

  const agentSkill = (agentId: string, skillId: string) => {
    const skill = exec(SkillRepository.use((r) => r.get(skillId)));

    if (!skill || skill.agentId !== agentId)
      throw new NotFound({ message: "Skill not found" });

    return skill;
  };

  register(routes.agentSkills, (c) =>
    c.json(
      exec(
        SkillRepository.use((r) => r.list(service.agent(c.req.param("id")).id)),
      ),
      200,
    ),
  );
  register(routes.createAgentSkill, async (c) => {
    const input = {
      ...skillInput.parse(await c.req.json()),
      agentId: service.agent(c.req.param("id")).id,
    };

    return c.json(exec(SkillRepository.use((r) => r.create(input))), 201);
  });
  register(routes.updateAgentSkill, async (c) => {
    const old = agentSkill(
      service.agent(c.req.param("id")).id,
      c.req.param("skillId"),
    );

    const body = await c.req.json();
    const lifecycle = skillLifecycleInput.parse(body);

    return c.json(
      exec(
        SkillRepository.use((r) =>
          r.update(old.id, {
            ...skillInput.parse({ ...old, ...body }),
            ...(lifecycle.state && { state: lifecycle.state }),
            ...(lifecycle.pinned !== undefined && { pinned: lifecycle.pinned }),
          }),
        ),
      ),
      200,
    );
  });
  register(routes.deleteAgentSkill, (c) => {
    exec(
      SkillRepository.use((r) =>
        r.delete(
          agentSkill(
            service.agent(c.req.param("id")).id,
            c.req.param("skillId"),
          ).id,
        ),
      ),
    );

    return c.body(null, 204);
  });
  register(routes.agentReviews, (c) =>
    c.json(
      exec(
        LearnedChangeRepository.use((r) =>
          r.listReviewResults(
            service.agent(c.req.param("id")).id,
            reviewsInput.parse(c.req.query()).limit,
          ),
        ),
      ),
      200,
    ),
  );
  register(routes.changes, (c) => {
    const query = changesInput.parse(c.req.query());

    if (query.agentId && query.agentId !== "shared")
      service.agent(query.agentId);

    return c.json(
      exec(
        LearnedChangeRepository.use((r) =>
          r.list(query.agentId === "shared" ? null : query.agentId, {
            limit: query.limit,
            before: query.before,
          }),
        ),
      ),
      200,
    );
  });
  register(routes.revertChange, (c) => {
    const reverted = exec(
      ChangeReverter.use((r) =>
        r.revert(c.req.param("id"), {
          actor: "owner",
        }),
      ),
    );

    if (!reverted) throw new NotFound({ message: "Change not found" });

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
        ...exec(SkillRepository.use((r) => r.list(null))).map((skill) => ({
          ...skill,
          source: "shared" as const,
        })),
      ],
      200,
    ),
  );
  register(routes.getSkill, (c) => {
    const skill = exec(SkillRepository.use((r) => r.get(c.req.param("id"))));

    if (!skill || skill.agentId)
      throw new NotFound({ message: "Skill not found" });

    return c.json(skill, 200);
  });
  register(routes.createSkill, async (c) => {
    const input = skillInput.parse(await c.req.json());

    return c.json(exec(SkillRepository.use((r) => r.create(input))), 201);
  });
  register(routes.updateSkill, async (c) => {
    if (options.commonSkills?.some((skill) => skill.id === c.req.param("id")))
      throw new ReadOnly({ message: "Bundled skills are read-only" });
    const old = exec(SkillRepository.use((r) => r.get(c.req.param("id"))));

    if (!old || old.agentId) throw new NotFound({ message: "Skill not found" });

    const input = skillInput.parse({ ...old, ...(await c.req.json()) });

    return c.json(
      exec(SkillRepository.use((r) => r.update(old.id, input))),
      200,
    );
  });
  register(routes.deleteSkill, (c) => {
    const skillId = c.req.param("id");

    if (options.commonSkills?.some((skill) => skill.id === skillId))
      throw new ReadOnly({ message: "Bundled skills are read-only" });

    if (
      exec(SkillRepository.use((r) => r.get(skillId)))?.agentId ||
      !exec(SkillRepository.use((r) => r.delete(skillId)))
    )
      throw new NotFound({ message: "Skill not found" });

    for (const agent of exec(AgentRepository.use((r) => r.list))) {
      const shared = agent.sharedSkills ?? [];

      if (shared.includes(skillId))
        exec(
          AgentRepository.use((r) =>
            r.update(agent.id, {
              sharedSkills: shared.filter((id) => id !== skillId),
            }),
          ),
        );
    }

    return c.body(null, 204);
  });
  register(routes.schedules, (c) =>
    c.json(
      exec(ScheduleRepository.use((r) => r.list(c.req.query("agentId")))),
      200,
    ),
  );
  register(routes.createSchedule, async (c) =>
    c.json(scheduler.create(scheduleInput.parse(await c.req.json())), 201),
  );
  register(routes.updateSchedule, async (c) => {
    const old = exec(ScheduleRepository.use((r) => r.get(c.req.param("id"))));

    if (!old) throw new NotFound({ message: "Schedule not found" });

    return c.json(
      scheduler.update(
        old.id,
        scheduleInput.parse({ ...old, ...(await c.req.json()) }),
      ),
      200,
    );
  });
  register(routes.deleteSchedule, (c) => {
    if (!exec(ScheduleRepository.use((r) => r.delete(c.req.param("id")))))
      throw new NotFound({ message: "Schedule not found" });

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
    c.json(
      exec(ExecutionRepository.use((r) => r.list(c.req.query("agentId")))),
      200,
    ),
  );
  register(routes.activity, async (c) => {
    const input = activityInput.parse(c.req.query());
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;

    if (input.cursor && !cursor)
      throw new InvalidInput({ message: "Invalid cursor" });

    const agents = input.agentId
      ? [service.agent(input.agentId)]
      : exec(AgentRepository.use((r) => r.list));

    const feed: z.output<typeof activityFeedResponse> = await activityPage({
      // History is durable per agent; skip bots that have never opened a conversation so
      // this read-only feed does not initialize empty chats.
      agents: agents.filter(
        (agent) =>
          exec(ConversationRepository.use((r) => r.list(agent.id, true)))
            .length,
      ),
      history: (agent, before, limit) =>
        runtime.history(agent, {
          limit,
          before,
          includeActiveAssistant: true,
        }),
      changes: (limit, before) =>
        exec(
          LearnedChangeRepository.use((r) =>
            r.list(input.agentId, { limit, before }),
          ),
        ),
      agentName: (id) =>
        exec(AgentRepository.use((r) => r.get(id)))?.name ?? null,
      limit: input.limit,
      cursor,
      kind: input.kind,
    });

    return c.json(feed, 200);
  });

  register(routes.providers, async (c) => {
    const saved = new Map(
      exec(ProviderCredentialRepository.use((r) => r.list)).map((info) => [
        info.providerId,
        info.type,
      ]),
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
      throw new Unavailable({
        message: "Provider credentials could not be read",
      });
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
      throw new Conflict({
        message: `This provider signs in outside Crumble. Sign out on the server: ${external.signOutCommand ?? "see its documentation"}`,
      });

    await providerAuth.signOut(name);

    return c.body(null, 204);
  });
  register(routes.startProviderLogin, async (c) => {
    const name = c.req.param("provider");

    if (!models.getProvider(name))
      throw new NotFound({ message: "Unknown provider" });
    const input = providerLoginInput.parse(await c.req.json());

    return c.json(providerAuth.start(name, input.method), 202);
  });
  register(routes.getProviderLogin, (c) =>
    c.json(providerAuth.get(c.req.param("id")), 200),
  );
  register(routes.answerProviderLogin, async (c) => {
    const input = providerLoginAnswerInput.safeParse(await c.req.json());

    // Answers can be secrets or callback URLs; never echo them in validation details.
    if (!input.success) throw new InvalidInput({ message: "Invalid answer" });

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
    const auth = hasOAuthTokens(secrets, server.id)
      ? "oauth"
      : exec(SecretRepository.use((r) => r.get(`mcp:${server.id}`)))
        ? "token"
        : "none";

    return {
      ...server,
      auth,
      authenticated: auth !== "none",
      error: integrations?.failure(server.id) ?? null,
      hasOAuthClientSecret: Boolean(
        exec(SecretRepository.use((r) => r.get(clientSecretKey(server.id)))),
      ),
    } as const;
  };

  const mcpServer = (id: string) => {
    const server = exec(McpServerRepository.use((r) => r.get(id)));

    if (!server) throw new NotFound({ message: "MCP server not found" });

    return server;
  };

  // Writing an empty secret removes the stored one.
  const storeSecret = (key: string, value: string | undefined) => {
    if (value === undefined) return;

    if (value) exec(SecretRepository.use((r) => r.set(key, value)));
    else exec(SecretRepository.use((r) => r.delete(key)));
  };

  register(routes.mcpServers, (c) =>
    c.json(
      exec(McpServerRepository.use((r) => r.list)).map(describeServer),
      200,
    ),
  );
  // OAuth sign-in: the client opens the returned URL, then posts back the code, state and issuer it receives.
  register(routes.oauth, async (c) => {
    const { redirectUri } = oauthInput.parse(await c.req.json());

    return c.json(
      await startAuthorization(
        secrets,
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
      secrets,
      server,
      code,
      state,
      iss,
      options.oauthClient,
    );

    if (integrations)
      await Effect.runPromise(integrations.disconnect(server.id));

    return c.json(describeServer(server), 200);
  });
  register(routes.deleteOauth, async (c) => {
    const server = mcpServer(c.req.param("id"));
    signOut(secrets, server.id);

    if (integrations)
      await Effect.runPromise(integrations.disconnect(server.id));

    return c.json(describeServer(server), 200);
  });

  // A server added with `agentId` belongs to that bot, which starts using it right away.
  register(routes.createMcpServer, async (c) => {
    const input = mcpCreateInput.parse(await c.req.json());

    const owner = input.agentId ? service.agent(input.agentId) : null;

    if (owner && owner.mcpServers.length >= 30)
      throw new InvalidInput({
        message: `${owner.name} already uses 30 MCP servers`,
      });
    const server = exec(McpServerRepository.use((r) => r.create(input)));

    storeSecret(`mcp:${server.id}`, input.token);
    storeSecret(clientSecretKey(server.id), input.oauthClientSecret);

    if (owner)
      exec(
        AgentRepository.use((r) =>
          r.update(owner.id, {
            mcpServers: [...owner.mcpServers, server.id],
          }),
        ),
      );

    return c.json(server, 201);
  });
  register(routes.updateMcpServer, async (c) => {
    const old = mcpServer(c.req.param("id"));
    const input = mcpInput.parse({ ...old, ...(await c.req.json()) });

    storeSecret(`mcp:${old.id}`, input.token);

    const secretChanged =
      input.oauthClientSecret !== undefined &&
      input.oauthClientSecret !==
        exec(SecretRepository.use((r) => r.get(clientSecretKey(old.id))));

    storeSecret(clientSecretKey(old.id), input.oauthClientSecret);

    // Tokens belong to the client that obtained them, so another client signs in again.
    if (secretChanged || (input.oauthClientId ?? null) !== old.oauthClientId) {
      signOut(secrets, old.id);

      if (integrations)
        await Effect.runPromise(integrations.disconnect(old.id));
    }

    return c.json(
      exec(
        McpServerRepository.use((r) =>
          r.update(old.id, {
            ...input,
            oauthClientId: input.oauthClientId ?? null,
          }),
        ),
      ),
      200,
    );
  });
  register(routes.deleteMcpServer, (c) => {
    if (!exec(McpServerRepository.use((r) => r.delete(c.req.param("id")))))
      throw new NotFound({ message: "MCP server not found" });
    exec(SecretRepository.use((r) => r.delete(`mcp:${c.req.param("id")}`)));
    exec(
      SecretRepository.use((r) => r.delete(clientSecretKey(c.req.param("id")))),
    );
    signOut(secrets, c.req.param("id"));

    return c.body(null, 204);
  });

  return app;
}
