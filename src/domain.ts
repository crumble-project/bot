import { z } from "zod";

export const agentInput = z.object({
  name: z.string().trim().min(1).max(80),
  avatar: z.string().max(100).default("bot"),
  description: z.string().max(1000).default(""),
  instructions: z
    .string()
    .max(32000)
    .default("You are a thoughtful, capable personal assistant."),
  provider: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/)
    .default("openai"),
  model: z.string().trim().min(1).max(200).default("gpt-4.1"),
  enabled: z.boolean().default(true),
  tools: z.array(z.string().min(1).max(200)).max(100).default(["memory"]),
  skills: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        instructions: z.string().max(32000),
      }),
    )
    .max(30)
    .default([]),
  /** Shared skills from the skill library this bot uses, besides its own `skills`. */
  sharedSkills: z.array(z.string().uuid()).max(100).optional(),
  /** Whether this bot recalls and manages shared memories, besides its own. */
  sharedMemory: z.boolean().optional(),
  mcpServers: z.array(z.string().uuid()).max(30).default([]),
  delegates: z.array(z.string().uuid()).max(30).default([]),
  inference: z
    .object({
      thinkingLevel: z
        .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
        .default("off"),
      temperature: z.number().min(0).max(2).optional(),
      maxOutputTokens: z.number().int().min(1).max(1000000).optional(),
    })
    .optional(),
});

export type AgentInput = z.infer<typeof agentInput>;

export type Agent = AgentInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type Conversation = {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
};

/** A memory belongs to one bot, or is shared when `agentId` is null. */
/** Where a memory was saved; names are the ones current at the time. */
export const memorySource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat") }),
  z.object({ kind: z.literal("owner") }),
  z.object({
    kind: z.literal("task"),
    scheduleId: z.string(),
    name: z.string(),
  }),
  z.object({ kind: z.literal("bot"), agentId: z.string(), name: z.string() }),
  z.object({ kind: z.literal("group"), groupId: z.string(), name: z.string() }),
]);

export type MemorySource = z.infer<typeof memorySource>;

export type Memory = {
  id: string;
  agentId: string | null;
  content: string;
  /** Null for memories saved before sources were recorded. */
  source: MemorySource | null;
  createdAt: string;
  updatedAt: string;
};

export const scheduleInput = z
  .object({
    agentId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(32000),
    cron: z.string().max(100).nullable().default(null),
    timezone: z.string().max(100).default("UTC"),
    runAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString())
      .nullable()
      .default(null),
    enabled: z.boolean().default(true),
  })
  .refine(
    (v) => Boolean(v.cron) !== Boolean(v.runAt),
    "Choose a recurring cron or one-time date",
  );

export type ScheduleInput = z.infer<typeof scheduleInput>;

export type Schedule = ScheduleInput & {
  id: string;
  nextRunAt: string | null;
  createdAt: string;
  /** The bot that saved this task, or null when the owner saved it. */
  createdByAgentId: string | null;
};

export type Execution = {
  id: string;
  agentId: string;
  conversationId: string;
  scheduleId: string | null;
  submissionId: string | null;
  requestId: string;
  prompt: string;
  replyTo?: string | null;
  /** Identifies the message's attachments, so a retried request ID must carry the same files. */
  attachmentsDigest?: string | null;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

/** An MCP server is shared, or belongs to the one bot in `agentId` with its own credentials. */
export type MCPServer = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  agentId: string | null;
};

export const skillInput = z.object({
  name: z.string().trim().min(1).max(100),
  instructions: z.string().max(32000),
});

/** A shared skill in the library, used by the bots that list it in `sharedSkills`. */
export type Skill = z.infer<typeof skillInput> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export const MIN_GROUP_MEMBERS = 2;
export const MAX_GROUP_MEMBERS = 6;

export const groupChatInput = z.object({
  name: z.string().trim().min(1).max(80),
  /** Member bots in the order they joined. */
  memberIds: z
    .array(z.string().uuid())
    .min(MIN_GROUP_MEMBERS)
    .max(MAX_GROUP_MEMBERS)
    .refine((ids) => new Set(ids).size === ids.length, "List each bot once"),
});

export type GroupChatInput = z.infer<typeof groupChatInput>;

/** A conversation between the owner and several bots, with one shared transcript. */
export type GroupChat = GroupChatInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

/** Bot-started turns a group allows since the owner's last message before it pauses. */
export const GROUP_TURN_BUDGET = 8;

/** A member's place in a group: its working conversation and the group messages it has seen. */
export type GroupMember = {
  groupId: string;
  agentId: string;
  /** The member's task-owned conversation for this group, created on its first turn. */
  conversationId: string | null;
  /** Number of the last group entry the member's turns have included. */
  cursor: number;
  /** Woken while busy: one more turn starts when the current one settles. */
  pending: boolean;
  /** Every wake behind the pending turn came from a bot message. */
  pendingBotStarted: boolean;
  /** Summary of the messages before the member joined, written once for its first turn. */
  summary: string | null;
  joinedAt: string;
};

export type GroupTurnStatus = "running" | "posting" | "settled";

/** One member's turn in a group, carried out by an execution in its group conversation. */
export type GroupTurn = {
  executionId: string;
  groupId: string;
  agentId: string;
  /** Number of the last group entry the turn's input included. */
  through: number;
  botStarted: boolean;
  status: GroupTurnStatus;
  createdAt: string;
};

/** The public ID of one of an agent's conversations; a client passes it back as given. */
export const conversationReference = (agentId: string, localId: number) =>
  `${agentId}:${localId}`;

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
