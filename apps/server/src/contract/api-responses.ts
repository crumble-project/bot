import { z } from "@hono/zod-openapi";
import { botCommunication } from "../bots/transcript";

const strings = z.array(z.string());

const thinkingLevel = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const inference = z.object({
  thinkingLevel: thinkingLevel.optional(),
  temperature: z.number().optional(),
  maxOutputTokens: z.number().optional(),
});

export const healthResponse = z
  .object({ status: z.literal("ok"), apiVersion: z.literal(1) })
  .openapi("Health");

export const capabilitiesResponse = z
  .object({
    coding: z.boolean().openapi({
      description: "Whether bots can be given the coding tool on this server.",
    }),
    desktop: z.boolean().openapi({
      description:
        "Whether bots can be given the desktop tool, and with it a bot desktop, on this server.",
    }),
  })
  .openapi("Capabilities");

export const agentResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    avatar: z.string(),
    description: z.string(),
    instructions: z.string(),
    provider: z.string(),
    model: z.string(),
    enabled: z.boolean(),
    tools: strings.openapi({
      description:
        "The bot's tools; always includes `schedule` and `codemode`.",
    }),
    skills: z.array(z.object({ name: z.string(), instructions: z.string() })),
    sharedSkills: strings.optional(),
    sharedMemory: z.boolean().optional().openapi({
      description:
        "True whenever `tools` includes `memory`; the server ignores it in input.",
    }),
    mcpServers: strings,
    delegates: strings.openapi({
      description:
        "Every other bot; with `delegate` in `tools` this bot may message any of them. The server ignores it in input.",
    }),
    inference: inference.optional(),
    desktopModel: z
      .object({ provider: z.string(), model: z.string() })
      .optional()
      .openapi({
        description:
          "The model for this bot's desktop jobs; unset, they use the bot's own model.",
      }),
    review: z
      .object({
        enabled: z.boolean(),
        skillThreshold: z.number().int(),
        memoryThreshold: z.number().int(),
        maxInputTokens: z.number().int().optional(),
      })
      .optional()
      .openapi({
        description:
          "How the bot reviews its turns to learn: whether at all, after how many tool-activity rounds for skills and memory, and how much of a turn a review reads. Unset means enabled with thresholds of 10.",
      }),
    reviewModel: z
      .object({ provider: z.string(), model: z.string() })
      .optional()
      .openapi({
        description:
          "The model that runs this bot's reviews; unset, they use the bot's own model.",
      }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Agent");

export const agentPreviewResponse = agentResponse
  .extend({ lastMessage: z.string().optional() })
  .openapi("AgentPreview");

const conversation = z
  .object({
    id: z.string(),
    agentId: z.string(),
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    archived: z.boolean().optional(),
  })
  .openapi("Conversation");

const origin = z
  .object({
    kind: z.string().openapi({
      description:
        "Where the message came from: owner, task, script (a script task's result), credential, bot, or group. Clients may receive other values later.",
    }),
    name: z.string().optional(),
    agentId: z.string().optional(),
  })
  .openapi("MessageOrigin");

// Rebuilt with the OpenAPI-extended `z`: a schema made before the extension loads has no `.openapi`.
const communication = z
  .object(botCommunication.shape)
  .openapi("BotCommunication");

const attachment = z
  .object({
    name: z.string(),
    mimeType: z.string(),
    size: z.number(),
    kind: z.enum(["image", "text"]),
  })
  .openapi("AttachmentInfo");

const message = z
  .object({
    id: z.string(),
    entryId: z.string(),
    requestId: z.string().optional(),
    role: z.string(),
    content: z.string(),
    blocks: z.unknown().optional().openapi({
      description: "Provider content blocks, with inline image bytes removed.",
    }),
    stopReason: z.string().optional(),
    timestamp: z.number().optional(),
    kind: z.string().optional(),
    replyTo: z.string().optional(),
    replyPreview: z.string().optional(),
    origin: origin.optional(),
    communication: communication.optional(),
    attachments: z.array(attachment).optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
    toolDetails: z.unknown().optional().openapi({
      description:
        "Provider-specific tool details, including nested code-mode calls.",
    }),
  })
  .openapi("TranscriptMessage");

export const historyResponse = z
  .object({
    messages: z.array(message),
    hasMore: z.boolean(),
    oldestEntryId: z.string().nullable(),
  })
  .openapi("TranscriptPage");

const jobsResponse = (kind: "Coding" | "Desktop") =>
  z
    .object({
      jobs: z
        .array(
          z
            .object({
              name: z.string(),
              conversationId: z.string(),
              status: z.enum(["working", "idle"]),
              usage: z.unknown().optional().openapi({
                description:
                  "Pi Durable usage document of the job's own conversation: tokens and cost per model and tool. Absent before its first request.",
              }),
            })
            .openapi(`${kind}Job`),
        )
        .openapi({ description: "Oldest job first." }),
    })
    .openapi(`${kind}Jobs`);

export const codingJobsResponse = jobsResponse("Coding");

export const desktopJobsResponse = jobsResponse("Desktop");

export const desktopControlResponse = z
  .object({
    holder: z.enum(["bot", "owner"]).openapi({
      description:
        "Who operates the bot desktop. While the owner holds control, the bot's desktop job pauses and only the owner's viewer input reaches the bot desktop.",
    }),
    changes: z.number().int().openapi({
      description:
        "How often control changed hands. A desktop job refuses actions it planned before a change.",
    }),
    updatedAt: z.string(),
  })
  .openapi("DesktopControl");

export const desktopViewerResponse = z
  .object({
    path: z.string().openapi({
      description:
        "Server-relative URL of the viewer page, a noVNC client of the bot desktop. Load it in a web view; it works once and expires at expiresAt unless its connection has started by then.",
    }),
    expiresAt: z.string(),
  })
  .openapi("DesktopViewer");

export const chatSnapshotResponse = historyResponse
  .extend({
    conversationId: z.string(),
    agentId: z.string(),
    conversation,
    live: z.unknown().optional().openapi({
      description:
        "Pi Durable live progress state. In-flight assistant message content is omitted.",
    }),
    partial: z.string(),
    usage: z
      .unknown()
      .optional()
      .openapi({ description: "Pi Durable usage document." }),
    status: z.enum(["idle", "running", "failed"]),
    updatedAt: z.number(),
    error: z.string().nullable(),
  })
  .openapi("ChatSnapshot");

export const groupChatResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    memberIds: strings.openapi({
      description: "Member bots in the order they joined.",
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("GroupChat");

export const groupActivityResponse = z
  .object({
    paused: z.boolean().openapi({
      description:
        "Bot-started turns used up the turn budget; the owner's next message resumes the group.",
    }),
    botTurns: z.number().openapi({
      description: "Bot-started turns since the owner's last message.",
    }),
    members: z.array(
      z
        .object({
          agentId: z.string(),
          status: z.enum(["idle", "queued", "running", "disabled"]),
          error: z.string().nullable().openapi({
            description: "Why the member's latest turn failed.",
          }),
        })
        .openapi("GroupMemberActivity"),
    ),
  })
  .openapi("GroupActivity");

export const groupChatSnapshotResponse = historyResponse
  .extend({
    groupChat: groupChatResponse,
    activity: groupActivityResponse,
    updatedAt: z.number(),
  })
  .openapi("GroupChatSnapshot");

export const groupMessageReceiptResponse = z
  .object({ requestId: z.string(), entryId: z.string() })
  .openapi("GroupMessageReceipt");

export const executionResponse = z
  .object({
    id: z.string(),
    agentId: z.string(),
    conversationId: z.string(),
    scheduleId: z.string().nullable(),
    submissionId: z.string().nullable(),
    requestId: z.string(),
    prompt: z.string(),
    replyTo: z.string().nullable().optional(),
    attachmentsDigest: z.string().nullable().optional(),
    status: z.enum(["pending", "running", "done", "failed", "cancelled"]),
    error: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Execution");

export const scriptRunResponse = z
  .object({
    id: z.string(),
    scheduleId: z.string(),
    agentId: z.string(),
    command: z.string(),
    status: z.enum([
      "running",
      "succeeded",
      "failed",
      "timed_out",
      "interrupted",
    ]),
    exitCode: z.number().int().nullable(),
    output: z.string().openapi({
      description: "The last 64 KiB and 2000 lines of combined output.",
    }),
    droppedBytes: z
      .number()
      .int()
      .openapi({ description: "Bytes dropped from the output tail." }),
    error: z.string().nullable(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("ScriptRun");

export const scheduleRunResponse = z
  .object({
    admitted: z.boolean(),
    result: z
      .object({
        ...executionResponse.partial().shape,
        status: z.string().optional(),
      })
      .loose()
      .openapi("ScheduleRunResult")
      .optional(),
  })
  .openapi("ScheduleRun");

// One object with optional fields rather than a union, so client generators keep it.
const memorySourceResponse = z
  .object({
    kind: z.enum(["chat", "owner", "task", "bot", "group"]),
    name: z.string().optional().openapi({
      description:
        "The task, bot, or group chat, as named when the memory was saved.",
    }),
    scheduleId: z.string().optional().openapi({ description: "For `task`." }),
    agentId: z.string().optional().openapi({ description: "For `bot`." }),
    groupId: z.string().optional().openapi({ description: "For `group`." }),
  })
  .openapi("MemorySource", {
    description:
      "Where the memory was saved: the owner's bot chat, the owner directly, a scheduled task, another bot's request, or a group chat.",
  });

export const credentialResponse = z
  .object({
    name: z.string(),
    hosts: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .openapi("Credential");

export const credentialRequestResponse = z
  .object({
    name: z.string(),
    hosts: z.array(z.string()),
    reason: z.string(),
    requestedAt: z.string(),
  })
  .openapi("CredentialRequest");

export const credentialsResponse = z
  .object({
    credentials: z.array(credentialResponse),
    requests: z.array(credentialRequestResponse),
  })
  .openapi("Credentials");

export const credentialUseResponse = z
  .object({
    id: z.string(),
    at: z.string(),
    method: z.string(),
    host: z.string(),
    path: z.string(),
    status: z.number().int().nullable(),
  })
  .openapi("CredentialUse");

export const memoryResponse = z
  .object({
    id: z.string(),
    agentId: z.string().nullable(),
    content: z.string(),
    // Null for memories saved before sources were recorded. A bare nullable union keeps generators' projection simple.
    source: z.union([memorySourceResponse, z.null()]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Memory");

export const skillDocumentResponse = z
  .object({ path: z.string(), content: z.string() })
  .openapi("SkillDocument");

// The published shape of a skill, kept as is: ListedSkill refers to it, and a changed member of that union would be
// a breaking change. Responses permit additional properties, so handlers return the full package anyway.
export const skillResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    instructions: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Skill");

/** A skill as a full package, with its documents, provenance, usage, and lifecycle. A plain object, not an extension of Skill, so generators see one typed object. */
export const skillPackageResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    instructions: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    // The bot that owns the skill; null for a shared skill.
    agentId: z.string().nullable(),
    description: z.string(),
    documents: z.array(skillDocumentResponse),
    createdBy: z.enum(["owner", "bot"]),
    sourceExecutionId: z.string().nullable(),
    useCount: z.number().int(),
    lastUsedAt: z.string().nullable(),
    state: z.enum(["active", "stale", "archived"]),
    pinned: z.boolean(),
  })
  .openapi("SkillPackage");

export const listedSkillResponse = z
  .discriminatedUnion("source", [
    skillResponse.extend({ source: z.literal("shared") }),
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      instructions: z.string(),
      path: z.string(),
      source: z.literal("bundled"),
    }),
  ])
  .openapi("ListedSkill");

const changeSourceResponse = z
  .object({
    executionId: z.string().nullable().optional(),
    conversationId: z.string().nullable().optional(),
    groupId: z.string().nullable().optional(),
  })
  .openapi("ChangeSource");

export const learnedChangeResponse = z
  .object({
    id: z.string(),
    // The bot whose skill or memory changed; null for a shared one.
    agentId: z.string().nullable(),
    actor: z.enum(["owner", "bot", "review", "curator"]),
    target: z.enum(["skill", "memory"]),
    targetId: z.string(),
    action: z.enum(["create", "update", "delete", "revert"]),
    before: z.union([skillPackageResponse, memoryResponse, z.null()]),
    after: z.union([skillPackageResponse, memoryResponse, z.null()]),
    source: z.union([changeSourceResponse, z.null()]),
    revertsId: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("LearnedChange");

export const reviewResultResponse = z
  .object({
    executionId: z.string(),
    agentId: z.string(),
    createdAt: z.string(),
    changes: z.array(learnedChangeResponse),
  })
  .openapi("ReviewResult");

export const scheduleResponse = z
  .object({
    id: z.string(),
    agentId: z.string(),
    name: z.string(),
    prompt: z.string(),
    kind: z.enum(["prompt", "script"]),
    command: z.string().nullable(),
    timeoutSeconds: z.number().int(),
    notify: z.boolean(),
    cron: z.string().nullable(),
    timezone: z.string(),
    runAt: z.string().nullable(),
    enabled: z.boolean(),
    nextRunAt: z.string().nullable(),
    createdAt: z.string(),
    createdByAgentId: z.string().nullable(),
  })
  .openapi("Schedule");

const operationalActivity = z
  .object({
    id: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    entryId: z.string(),
    timestamp: z.number().optional(),
    kind: z.enum(["tool-call", "tool-result", "mcp-call", "bot-message"]),
    details: z.record(z.string(), z.unknown()),
  })
  .openapi("OperationalActivity");

const changeActivity = z
  .object({
    id: z.string(),
    // Null for a change to the shared library.
    agentId: z.string().nullable(),
    agentName: z.string().nullable(),
    timestamp: z.number(),
    kind: z.literal("change"),
    change: learnedChangeResponse,
  })
  .openapi("ChangeActivity");

export const activityFeedResponse = z
  .object({
    activities: z.array(z.union([operationalActivity, changeActivity])),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .openapi("ActivityFeed");

const authType = z.enum(["api_key", "oauth"]);

export const loginMethod = z
  .object({
    type: authType,
    label: z.string(),
    subscription: z.boolean(),
  })
  .openapi("ProviderLoginMethod");

/** How a provider that signs in outside Crumble stands, such as Claude Code. */
export const externalAuthResponse = z
  .object({
    status: z.enum([
      "signed_in",
      "signed_out",
      "cli_missing",
      "unsupported_version",
      "error",
    ]),
    /** The installed command-line tool's version, when it reported one. */
    cliVersion: z.string().nullable(),
    /** Versions Crumble is qualified with; any other is refused. */
    qualifiedVersions: z.array(z.string()),
    /** The command the owner runs on the server to sign in. */
    signInCommand: z.string().nullable(),
    signOutCommand: z.string().nullable(),
    message: z.string().nullable(),
  })
  .openapi("ProviderExternalAuth");

export const providerResponse = z
  .object({
    provider: z.string(),
    name: z.string(),
    /** Saved or ambient credentials make the provider usable. */
    configured: z.boolean(),
    authMethods: z.array(loginMethod),
    /** The provider's saved credential; ambient credentials have none. */
    credentialType: authType.nullable(),
    activeLoginId: z.string().nullable(),
    /** Set for providers whose sign-in happens outside Crumble; they have no `authMethods`. */
    externalAuth: externalAuthResponse.nullable(),
  })
  .openapi("Provider");

/** One object rather than a union, so generated clients keep the nullable prompt. */
export const loginPrompt = z.object({
  id: z.string(),
  type: z.enum(["text", "secret", "select", "manual_code"]),
  message: z.string(),
  placeholder: z.string().optional(),
  /** Present exactly for `select`; answer with an option's `id`. */
  options: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

export const loginEvent = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("info"),
      message: z.string(),
      links: z
        .array(z.object({ url: z.string(), label: z.string().optional() }))
        .optional(),
    }),
    z.object({
      type: z.literal("auth_url"),
      url: z.string(),
      instructions: z.string().optional(),
    }),
    z.object({
      type: z.literal("device_code"),
      userCode: z.string(),
      verificationUri: z.string(),
      intervalSeconds: z.number().optional(),
      expiresInSeconds: z.number().optional(),
    }),
    z.object({ type: z.literal("progress"), message: z.string() }),
  ])
  .openapi("ProviderLoginEvent");

export const loginSessionResponse = z
  .object({
    id: z.string(),
    provider: z.string(),
    method: authType,
    status: z.enum(["pending", "succeeded", "failed", "cancelled", "expired"]),
    createdAt: z.number(),
    expiresAt: z.number(),
    prompt: loginPrompt.nullable(),
    events: z.array(loginEvent),
    failure: z
      .object({
        code: z.enum([
          "provider_failure",
          "callback_unavailable",
          "storage_failure",
        ]),
        message: z.string(),
      })
      .nullable(),
  })
  .openapi("ProviderLoginSession");

export const modelResponse = z
  .object({
    provider: z.string(),
    id: z.string(),
    name: z.string(),
    contextWindow: z.number(),
    reasoning: z.boolean(),
    thinkingLevels: z.array(thinkingLevel).openapi({
      description:
        "The thinking levels this model takes, from lowest to highest. A bot's level outside them runs at the nearest one.",
    }),
  })
  .openapi("Model");

export const providerConfiguredResponse = z
  .object({ provider: z.string(), configured: z.boolean() })
  .openapi("ProviderConfigured");

export const mcpServerResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    enabled: z.boolean(),
    agentId: z.string().nullable(),
    oauthClientId: z.string().nullable().openapi({
      description:
        "The client ID of an OAuth app the owner registered with the server's authorization server, used instead of registering Crumble.",
    }),
  })
  .openapi("McpServer");

export const describedMcpServerResponse = mcpServerResponse
  .extend({
    auth: z.enum(["oauth", "token", "none"]),
    error: z.string().nullable().openapi({
      description:
        "Why the server's tools were left out of a bot's last turn, such as a missing sign-in; null once it connects again.",
    }),
    hasOAuthClientSecret: z.boolean().openapi({
      description:
        "Whether the OAuth app's client secret is stored; it is never returned.",
    }),
    authenticated: z.boolean(),
  })
  .openapi("McpServerStatus");

export const oauthStartResponse = z
  .union([
    z.object({ authorizationUrl: z.string() }),
    z.object({ authorized: z.literal(true) }),
  ])
  .openapi("McpOAuthStart");

export const compactResponse = z
  .object({ taskId: z.string() })
  .openapi("Compaction");

export const replyEvent = z
  .object({
    type: z.literal("reply"),
    eventId: z.string(),
    serverId: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    entryId: z.string().nullable(),
    origin: z.string().openapi({
      description:
        "What the bot answered: owner (a message from the owner), task (a scheduled task), script (a script task's result), bot (another bot's request), group (a group chat turn), or coding or desktop (a job's report; jobName names the job). Clients may receive other values later.",
    }),
    preview: z.string(),
    createdAt: z.string(),
    executionId: z.string().optional(),
    jobName: z.string().optional().openapi({
      description:
        "The job whose report the bot answered, for origin coding or desktop. A desktop job's report often asks for the owner; clients may open the bot desktop.",
    }),
    groupId: z.string().optional().openapi({
      description:
        "Set when a bot answered in a group chat; open the group rather than the bot chat.",
    }),
    groupName: z.string().optional(),
  })
  .openapi("ReplyEvent");

export const chatPreviewEvent = z
  .object({
    type: z.literal("chat-preview"),
    agentId: z.string(),
    agentName: z.string(),
    lastMessage: z.string(),
  })
  .openapi("ChatPreviewEvent");

export const learnedEvent = z
  .object({
    type: z.literal("learned"),
    agentId: z.string(),
    agentName: z.string(),
    // The execution the bot reviewed; the changes name what it learned from it.
    executionId: z.string(),
    changes: z.array(
      z.object({
        changeId: z.string(),
        target: z.enum(["skill", "memory"]),
        action: z.enum(["create", "update", "delete", "revert"]),
        name: z.string(),
      }),
    ),
    createdAt: z.string(),
  })
  .openapi("LearnedEvent", {
    description:
      "A bot's review of one of its turns changed its skills or memory, sent as the `learned` event on /v1/events. Clients show a short notice in the bot chat and link to the change record.",
  });

// LearnedEvent is its own `learned` SSE event, not a member of this union: adding a member would be a breaking
// change for clients that read the union as closed, while a new event name is ignored by every client.
export const activityEvent = z
  .discriminatedUnion("type", [replyEvent, chatPreviewEvent])
  .openapi("ActivityEvent");

export const heartbeatEvent = z.object({}).openapi("HeartbeatEvent");
