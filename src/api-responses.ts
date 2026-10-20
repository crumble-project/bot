import { z } from "@hono/zod-openapi";

const strings = z.array(z.string());

const inference = z.object({
  thinkingLevel: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional(),
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
  })
  .openapi("Capabilities");

export const pushStatusResponse = z
  .object({
    serverId: z.string(),
    transports: z.object({ apns: z.boolean(), fcm: z.boolean() }),
  })
  .openapi("PushStatus");

export const pushDeviceResponse = z
  .object({ serverId: z.string(), remoteDelivery: z.boolean() })
  .openapi("PushDeviceRegistration");

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
    tools: strings,
    skills: z.array(z.object({ name: z.string(), instructions: z.string() })),
    sharedSkills: strings.optional(),
    sharedMemory: z.boolean().optional(),
    mcpServers: strings,
    delegates: strings,
    inference: inference.optional(),
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
    kind: z.string(),
    name: z.string().optional(),
    agentId: z.string().optional(),
  })
  .openapi("MessageOrigin");

const communication = z
  .object({
    executionId: z.string(),
    fromAgentId: z.string(),
    fromName: z.string(),
    toAgentId: z.string(),
    toName: z.string(),
    status: z.enum(["sent", "done", "failed", "cancelled"]),
  })
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

export const codingJobsResponse = z
  .object({
    jobs: z
      .array(
        z
          .object({
            name: z.string(),
            conversationId: z.string(),
            status: z.enum(["working", "idle"]),
          })
          .openapi("CodingJob"),
      )
      .openapi({ description: "Oldest job first." }),
  })
  .openapi("CodingJobs");

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

export const groupChatSnapshotResponse = historyResponse
  .extend({ groupChat: groupChatResponse, updatedAt: z.number() })
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

export const memoryResponse = z
  .object({
    id: z.string(),
    agentId: z.string().nullable(),
    content: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Memory");

export const skillResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    instructions: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Skill");

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

export const scheduleResponse = z
  .object({
    id: z.string(),
    agentId: z.string(),
    name: z.string(),
    prompt: z.string(),
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

export const activityFeedResponse = z
  .object({ activities: z.array(operationalActivity), hasMore: z.boolean() })
  .openapi("ActivityFeed");

export const providerResponse = z
  .object({ provider: z.string(), name: z.string(), configured: z.boolean() })
  .openapi("Provider");

export const modelResponse = z
  .object({
    provider: z.string(),
    id: z.string(),
    name: z.string(),
    contextWindow: z.number(),
    reasoning: z.boolean(),
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
  })
  .openapi("McpServer");

export const describedMcpServerResponse = mcpServerResponse
  .extend({
    auth: z.enum(["oauth", "token", "none"]),
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
    origin: z.string(),
    preview: z.string(),
    createdAt: z.string(),
    executionId: z.string().optional(),
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

export const activityEvent = z
  .discriminatedUnion("type", [replyEvent, chatPreviewEvent])
  .openapi("ActivityEvent");

export const heartbeatEvent = z.object({}).openapi("HeartbeatEvent");
