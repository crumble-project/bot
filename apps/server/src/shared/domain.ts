import { z } from "zod";

export const MEMORY_SOURCE_KINDS = [
  "chat",
  "owner",
  "task",
  "bot",
  "group",
] as const;

const memorySourceKind = z.enum(MEMORY_SOURCE_KINDS);

/** Where a memory was saved; names are the ones current at the time. */
export const memorySource = z.discriminatedUnion("kind", [
  z.object({ kind: memorySourceKind.extract(["chat"]) }),
  z.object({ kind: memorySourceKind.extract(["owner"]) }),
  z.object({
    kind: memorySourceKind.extract(["task"]),
    scheduleId: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: memorySourceKind.extract(["bot"]),
    agentId: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: memorySourceKind.extract(["group"]),
    groupId: z.string(),
    name: z.string(),
  }),
]);

export type MemorySource = z.infer<typeof memorySource>;

/** A memory belongs to one bot, or is shared when `agentId` is null. */
export type Memory = {
  id: string;
  agentId: string | null;
  content: string;
  /** Null for memories saved before sources were recorded. */
  source: MemorySource | null;
  createdAt: string;
  updatedAt: string;
};

export const SCRIPT_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "interrupted",
] as const;

export const EXECUTION_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;

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
  status: (typeof EXECUTION_STATUSES)[number];
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export const ACTIVE_EXECUTION_STATUSES = ["pending", "running"] as const;

export const activeExecution = (execution: Pick<Execution, "status">) =>
  ACTIVE_EXECUTION_STATUSES.some((status) => status === execution.status);

/** The request a credential's value is read for: some values, such as a GitHub App's token, depend on it. */
export type CredentialTarget = { host: string; path: string };

/** Whether `host` is one of `hosts`; `*.example.com` covers every subdomain, not the name itself. */
export const hostMatches = (hosts: readonly string[], host: string) =>
  hosts.some((pattern) =>
    pattern.startsWith("*.")
      ? host.endsWith(pattern.slice(1))
      : pattern === host,
  );

export const CHANGE_ACTORS = ["owner", "bot", "review", "curator"] as const;

export type ChangeActor = (typeof CHANGE_ACTORS)[number];

/** Where a learned change came from: the execution and conversation of the turn, or the group it ran in. */
export type ChangeSource = {
  executionId?: string | null;
  conversationId?: string | null;
  groupId?: string | null;
};

/** Who made a skill or memory change, and from where; `null` records nothing, for migrations. */
export type ChangeBy = { actor: ChangeActor; source?: ChangeSource | null };

export const CHANGE_ACTIONS = ["create", "update", "delete", "revert"] as const;

export const CHANGE_TARGETS = ["skill", "memory"] as const;

export const WAITING_FOR = ["approval", "credential", "login"] as const;

/** Who operates a bot desktop. */
export const CONTROL_HOLDERS = ["bot", "owner"] as const;

/** Whose words an owner message a job acts for are. */
export const OWNER_MESSAGE_SOURCES = ["owner", "automation"] as const;

export const HELD_ACTION_STATUSES = [
  "pending",
  "approved",
  "declined",
  "expired",
] as const;

/** How an owner signs in to a provider. */
export const SIGN_IN_METHODS = ["api_key", "oauth"] as const;

export const ACTIVITY_KINDS = [
  "tool-call",
  "tool-result",
  "mcp-call",
  "bot-message",
] as const;

/** A long-lived connection's state: message gateways and the event relay report the same four. */
export const CONNECTION_STATUSES = [
  "disconnected",
  "connecting",
  "connected",
  "error",
] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
