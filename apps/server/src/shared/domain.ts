import { z } from "zod";

/** Tools every bot has, whatever its saved `tools` say. */
export const STANDARD_TOOLS = ["schedule", "codemode"];

/** A model other than the bot's own; null clears it in a patch. */
const modelChoice = z
  .object({
    provider: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9-]+$/),
    model: z.string().trim().min(1).max(200),
  })
  .nullable()
  .optional();

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
  webSearchProvider: z.enum(["mixed", "exa"]).nullable().optional(),
  enabled: z.boolean().default(true),
  tools: z.array(z.string().min(1).max(200)).max(100).default(["memory"]),
  /** The bot's own skills by name; the full records live in the skill library. Writing replaces them by name. */
  skills: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        instructions: z.string().max(32000),
      }),
    )
    .max(100)
    .default([]),
  /** Shared skills from the skill library this bot uses, besides its own `skills`. */
  sharedSkills: z.array(z.uuid()).max(100).optional(),
  /** Ignored: a bot with memory always uses shared memory too. */
  sharedMemory: z.boolean().optional(),
  mcpServers: z.array(z.uuid()).max(30).default([]),
  /** Ignored: a bot that may message other bots reaches every one of them. */
  delegates: z.array(z.uuid()).max(30).default([]),
  inference: z
    .object({
      thinkingLevel: z
        .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
        .default("off"),
      temperature: z.number().min(0).max(2).optional(),
      maxOutputTokens: z.number().int().min(1).max(1000000).optional(),
    })
    .optional(),
  /** How the bot reviews its work afterwards to learn skills and memory. Thresholds count tool-activity rounds. */
  review: z
    .object({
      enabled: z.boolean().default(true),
      skillThreshold: z.number().int().min(1).max(1000).default(10),
      memoryThreshold: z.number().int().min(1).max(1000).default(10),
      /** Caps the turn digest a review reads; unset, 75% of the review model's context window, at most 600000. */
      maxInputTokens: z.number().int().min(1000).max(2000000).optional(),
    })
    .optional(),
  /** The model that runs this bot's reviews; unset or null, they use the bot's own model. Null clears it in a patch. */
  reviewModel: modelChoice,
  /** The model for this bot's desktop jobs; unset or null, they use the bot's own model. Null clears it in a patch. */
  desktopModel: modelChoice,
});

export type AgentInput = z.infer<typeof agentInput>;

/** A stored bot: a cleared desktop or review model is absent, never null. */
export type Agent = Omit<AgentInput, "desktopModel" | "reviewModel"> & {
  desktopModel?: NonNullable<AgentInput["desktopModel"]>;
  reviewModel?: NonNullable<AgentInput["reviewModel"]>;
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type BotRequest = {
  id: string;
  agentId: string;
  proposal: AgentInput;
  reason: string;
  status: "pending" | "approved" | "declined";
  createdAgentId: string | null;
  requestedAt: string;
  decidedAt: string | null;
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

export type ScheduleKind = "prompt" | "script";

export type ScriptRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "interrupted";

export type ScriptRun = {
  id: string;
  scheduleId: string;
  agentId: string;
  command: string;
  status: ScriptRunStatus;
  exitCode: number | null;
  output: string;
  droppedBytes: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export const scheduleInput = z
  .object({
    agentId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    kind: z.enum(["prompt", "script"]).default("prompt"),
    prompt: z.string().trim().max(32000).default(""),
    command: z.string().max(8000).nullable().default(null),
    timeoutSeconds: z.number().int().min(1).max(3600).default(600),
    notify: z.boolean().default(true),
    cron: z.string().max(100).nullable().default(null),
    timezone: z.string().max(100).default("UTC"),
    runAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString())
      .nullable()
      .default(null),
    enabled: z.boolean().default(true),
  })
  .refine(
    (v) => Boolean(v.cron) !== Boolean(v.runAt),
    "Choose a recurring cron or one-time date",
  )
  .refine(
    (v) =>
      v.kind === "prompt"
        ? v.prompt.length > 0 && v.command === null
        : Boolean(v.command?.trim()),
    "Prompt tasks need a prompt and no command; script tasks need a command",
  );

export type ScheduleInput = z.infer<typeof scheduleInput>;

export const mergeScheduleInput = (
  existing: ScheduleInput,
  patch: Partial<ScheduleInput>,
): ScheduleInput => {
  const next = { ...existing, ...patch };

  return {
    ...next,
    prompt: next.kind === "script" ? "" : next.prompt,
    command: next.kind === "prompt" ? null : next.command,
  };
};

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
  /** A client the owner registered with the server's authorization server, for servers that register none themselves. */
  oauthClientId: string | null;
};

// Names the workspace, its shell, or the credential proxy itself depend on.
const RESERVED_CREDENTIAL_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TERM",
  "LANG",
  "HOSTNAME",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
]);

export const credentialName = z
  .string()
  .regex(
    /^[A-Z_][A-Z0-9_]{0,63}$/,
    "Credential names are environment variable names such as ACME_TOKEN",
  )
  .refine(
    (name) =>
      !RESERVED_CREDENTIAL_NAMES.has(name) && !name.startsWith("CRUMBLE_"),
    "This name is reserved for the workspace",
  );

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A public DNS name, or `*.` and one: the hosts a credential may be sent to. Addresses are not names. */
export const credentialHost = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine((host) => {
    const labels = host.replace(/^\*\./, "").split(".");

    return (
      labels.length >= 2 &&
      labels.every((label) => HOST_LABEL.test(label)) &&
      !/^[0-9]+$/.test(labels.at(-1)!)
    );
  }, "Hosts look like api.example.com or *.example.com");

export const credentialHosts = z
  .array(credentialHost)
  .min(1, "Name at least one host")
  .max(20)
  .transform((hosts) => [...new Set(hosts)]);

export const credentialRequestInput = z.object({
  name: credentialName,
  hosts: credentialHosts,
  reason: z.string().trim().min(1).max(1000),
});

export type CredentialRequestInput = z.infer<typeof credentialRequestInput>;

export const passwordManagerIdInput = z.enum(["1password", "bitwarden"]);

/** Settings key of a password manager: never rename. */
export type PasswordManagerId = z.infer<typeof passwordManagerIdInput>;

/** Where to read a secret's value instead of storing it: a password manager and a reference it understands. */
export const secretReferenceInput = z.object({
  passwordManager: passwordManagerIdInput,
  reference: z.string().trim().min(1).max(1000),
});

export type SecretReference = z.infer<typeof secretReferenceInput>;

export const credentialSaveInput = z
  .object({
    /** Kept when omitted; required for a credential nobody asked for. */
    hosts: credentialHosts.optional(),
    /** Write-only. A new credential needs it or `reference`; omit both to keep the saved source. */
    value: z.string().min(1).max(16000).optional(),
    /** Read the value from a password manager instead of storing it. */
    reference: secretReferenceInput.optional(),
  })
  .refine((input) => !(input.value !== undefined && input.reference), {
    message: "Send a value or a reference, not both",
    path: ["reference"],
  });

export type CredentialSaveInput = z.infer<typeof credentialSaveInput>;

/** A credential the owner gave one bot. Its value is write-only and never part of this record. */
export type AgentCredential = {
  name: string;
  hosts: string[];
  /** Where the value is read from; both null for a value stored in Crumble. */
  passwordManager: PasswordManagerId | null;
  reference: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** Why the newest use couldn't read the value; null when it could. */
  lastError: string | null;
};

/** A bot's request for a credential, waiting for the owner. */
export type CredentialRequest = {
  name: string;
  hosts: string[];
  reason: string;
  requestedAt: string;
};

/** What the credential proxy needs to swap a credential in: never leaves the server. */
/** A credential the proxy may swap in; its value is read only when a request uses the placeholder. */
export type CredentialGrant = {
  name: string;
  hosts: string[];
  placeholder: string;
};

/** Whether `host` is one of `hosts`; `*.example.com` covers every subdomain, not the name itself. */
export const hostMatches = (hosts: readonly string[], host: string) =>
  hosts.some((pattern) =>
    pattern.startsWith("*.")
      ? host.endsWith(pattern.slice(1))
      : pattern === host,
  );

/** One request the credential proxy sent with the real value. */
export type CredentialUse = {
  id: string;
  at: string;
  method: string;
  host: string;
  path: string;
  status: number | null;
  /** Why the value couldn't be read, so the request was never sent. */
  error: string | null;
};

export const MAX_SKILL_DOCUMENTS = 20;

/** A reference document inside a skill package, loaded only when the bot asks for it. */
export const skillDocumentInput = z.object({
  path: z
    .string()
    .regex(
      /^references\/[a-z0-9][a-z0-9._-]{0,99}\.md$/,
      "Document paths look like references/topic.md",
    ),
  content: z.string().min(1).max(64000),
});

export type SkillDocument = z.infer<typeof skillDocumentInput>;

export const skillInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).default(""),
  instructions: z.string().max(32000),
  documents: z
    .array(skillDocumentInput)
    .max(MAX_SKILL_DOCUMENTS)
    .default([])
    .refine(
      (documents) =>
        new Set(documents.map((document) => document.path)).size ===
        documents.length,
      "Document paths must be unique",
    ),
});

export type SkillInput = z.infer<typeof skillInput>;

export const skillStates = ["active", "stale", "archived"] as const;

export type SkillState = (typeof skillStates)[number];

/** What the owner may change on a skill beyond its content: its lifecycle state and whether the curator leaves it alone. */
export const skillLifecycleInput = z.object({
  state: z.enum(skillStates).optional(),
  pinned: z.boolean().optional(),
});

/** A skill package in the library: a bot's own when `agentId` is set, shared when null. */
export type Skill = SkillInput & {
  id: string;
  agentId: string | null;
  /** Who wrote the skill first; a bot's skills carry the execution they were learned from. */
  createdBy: "owner" | "bot";
  sourceExecutionId: string | null;
  useCount: number;
  lastUsedAt: string | null;
  state: SkillState;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

export const changeActors = ["owner", "bot", "review", "curator"] as const;

export type ChangeActor = (typeof changeActors)[number];

/** Where a learned change came from: the execution and conversation of the turn, or the group it ran in. */
export type ChangeSource = {
  executionId?: string | null;
  conversationId?: string | null;
  groupId?: string | null;
};

/** Who made a skill or memory change, and from where; `null` records nothing, for migrations. */
export type ChangeBy = { actor: ChangeActor; source?: ChangeSource | null };

export const changeActions = ["create", "update", "delete", "revert"] as const;

/** One recorded change to a skill or memory, with the state before and after, so the owner can undo it. */
export type LearnedChange = {
  id: string;
  /** The bot whose skill or memory changed; null for a shared one. */
  agentId: string | null;
  actor: ChangeActor;
  target: "skill" | "memory";
  targetId: string;
  action: (typeof changeActions)[number];
  before: Skill | Memory | null;
  after: Skill | Memory | null;
  source: ChangeSource | null;
  /** The change this one undid. */
  revertsId: string | null;
  createdAt: string;
};

export const MIN_GROUP_MEMBERS = 2;
export const MAX_GROUP_MEMBERS = 6;

export const groupChatInput = z.object({
  name: z.string().trim().min(1).max(80),
  /** Member bots in the order they joined. */
  memberIds: z
    .array(z.uuid())
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
