import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { z } from "zod";
import type {
  Conversation,
  ConversationId,
  ConversationRecord,
  Cursor,
  EntryId,
  EntryRecord,
  Harness,
} from "@earendil-works/pi-durable";

import { attachmentInput, type AttachmentInfo } from "../shared/attachments";
import { codingJobOf } from "../jobs/coding";
import { desktopJobOf } from "../jobs/desktop";
import { REACTION_TOOL_NAME, reactionOf } from "./reaction";
import { PASS_TOOL_NAME } from "../group-chats/group-turns";

type ModelContent = NonNullable<EntryRecord["model"]>[number]["content"];

type TranscriptEntryQuery = { order: "descending"; maxEntryId?: EntryId };

const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const jsonRecord = z.record(z.string(), z.json());

// Drops an unreadable name or agent ID instead of keeping it as `undefined`, so origins stay JSON.
const messageOrigin = z
  .object({
    kind: z.string(),
    name: z.string().optional().catch(undefined),
    agentId: z.string().optional().catch(undefined),
  })
  .transform(({ kind, name, agentId }) => {
    const origin: MessageOrigin = { kind };

    if (name !== undefined) origin.name = name;

    if (agentId !== undefined) origin.agentId = agentId;

    return origin;
  });

const attachmentInfo = z.object({
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  kind: z.enum(["image", "text"]),
});

export const botCommunication = z.object({
  executionId: z.string(),
  fromAgentId: z.string(),
  fromName: z.string(),
  toAgentId: z.string(),
  toName: z.string(),
  status: z.enum(["sent", "done", "failed", "cancelled"]),
});

const botMessage = z.object({
  content: z.string(),
  timestamp: z.number().optional().catch(undefined),
  communication: botCommunication,
});

export const GROUP_MESSAGE_KIND = "crumble.group-message";

/** A group chat message: the owner's or a bot's words, or a bot's reaction, written once under its request ID. */
export const groupMessageData = z.object({
  text: z.string(),
  sender: messageOrigin,
  requestId: z.string(),
  timestamp: z.number(),
  replyTo: z.string().exactOptional(),
  replyPreview: z.string().exactOptional(),
  /** The emoji of a reaction to `replyTo`; a reaction has no text. */
  reaction: z.string().exactOptional(),
  /** The owner's uploads, kept with the message so every member turn can include them. */
  attachments: z.array(attachmentInput).exactOptional(),
  /** What pages show for each upload, without its bytes. */
  files: z.array(attachmentInfo).exactOptional(),
});

export type GroupMessageData = z.infer<typeof groupMessageData>;

const inputMetadata = z.object({
  text: z.string().optional().catch(undefined),
  replyTo: z.string().optional().catch(undefined),
  requestId: z.string().optional().catch(undefined),
  replyPreview: z.string().optional().catch(undefined),
});

const toolMetadata = z.object({
  toolCallId: z.string().optional().catch(undefined),
  toolName: z.string().optional().catch(undefined),
  isError: z.boolean().optional().catch(undefined),
  details: z.unknown().optional(),
});

export type MessageOrigin = { kind: string; name?: string; agentId?: string };

export type BotCommunication = {
  executionId: string;
  fromAgentId: string;
  fromName: string;
  toAgentId: string;
  toName: string;
  status: "sent" | "done" | "failed" | "cancelled";
};

export type BotMessageEvent = {
  content: string;
  communication: BotCommunication;
};

export type TranscriptMessage = {
  id: string;
  entryId: string;
  /** Stable admission ID copied from the durable input metadata for optimistic reconciliation. */
  requestId?: string | undefined;
  role: string;
  content: string;
  blocks?: unknown;
  /** Provider terminal reason, used to hide aborted/error partials from chat views. */
  stopReason?: string;
  timestamp?: number | undefined;
  kind?: string;
  replyTo?: string;
  replyPreview?: string;
  origin?: MessageOrigin;
  communication?: BotCommunication;
  attachments?: AttachmentInfo[];
  /** Tool result metadata is carried on the model message, rather than its content blocks. */
  toolCallId?: string;
  toolName?: string | undefined;
  isError?: boolean | undefined;
  /** Provider-specific details, including codemode nested tool calls. */
  toolDetails?: unknown;
};

export type TranscriptPage = {
  messages: TranscriptMessage[];
  hasMore: boolean;
  oldestEntryId: string | null;
};

// Structural-only model output has no text block; normalize() puts a hint in content for chat display.
function hasTextBlock(message: TranscriptMessage) {
  return Array.isArray(message.blocks)
    ? message.blocks.some((block) => textBlock.safeParse(block).success)
    : Boolean(message.content.trim());
}

/** Short, user-facing text for an agent list/sidebar. Structural tool and thinking blocks are excluded. */
export function latestMessagePreview(messages: TranscriptMessage[]): string {
  for (const message of [...messages].reverse()) {
    if (message.kind === "bot-message") {
      const text = message.content.trim();

      if (text) return text.slice(0, 240);
    }

    const reaction = reactionOf(message);

    if (reaction) return `Reacted ${reaction}`;
    const job = codingJobOf(message);

    if (job) return `Coding job ${job}`;
    const desktopJob = desktopJobOf(message);

    if (desktopJob) return `Desktop job ${desktopJob}`;

    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.content.trim();

    if (text && hasTextBlock(message)) return text.slice(0, 240);
    const attachment = message.attachments?.[0];

    if (attachment) return `Attachment: ${attachment.name}`;
  }

  return "";
}

/** The bot's output after the latest input: its last text reply, and the emoji it reacted with, if any. */
export function latestReply(messages: TranscriptMessage[]) {
  const input = messages.findLastIndex((message) => message.role === "user");
  const output = messages.slice(input + 1);

  return {
    reply: output.findLast(
      (message) => message.role === "assistant" && hasTextBlock(message),
    ),
    reaction: output.map(reactionOf).findLast(Boolean),
  };
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;
const REPLY_WINDOW = 20;
const INPUT_KINDS = new Set(["crumble.message", "pi.user"]);

export function parseEntryRef(
  agentId: string,
  value: string,
  label: string,
): number {
  const prefix = `${agentId}:`;

  if (!value.startsWith(prefix))
    throw new Error(`${label} belongs to a different agent`);
  const raw = value.slice(prefix.length);

  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new Error(`Invalid ${label}`);

  return Number(raw);
}

const entryRef = (agentId: string, id: number) => `${agentId}:${id}`;

function textOf(content: ModelContent | undefined): string {
  if (!Array.isArray(content)) return content ?? "";

  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

function blockHint(content: ModelContent): string {
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block?.type === "toolCall")
        return `Tool call: ${String(block.name ?? "unknown")}`;

      if (block?.type === "thinking") return "Thinking";

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function record(value: JsonValue | undefined) {
  const parsed = jsonRecord.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

function originOf(value: JsonValue | undefined): MessageOrigin | undefined {
  const parsed = messageOrigin.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

function attachmentsOf(value: JsonValue | undefined): AttachmentInfo[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    const parsed = attachmentInfo.safeParse(item);

    return parsed.success ? [parsed.data] : [];
  });
}

/** Image bytes stay out of snapshots and pages; clients fetch them by attachment index instead. */
function withoutImageData(content: ModelContent) {
  if (!Array.isArray(content)) return content;

  return content.map((block) =>
    block?.type === "image"
      ? { type: "image", mimeType: block.mimeType }
      : block,
  );
}

function normalize(agentId: string, entry: EntryRecord): TranscriptMessage[] {
  const entryId = entryRef(agentId, Number(entry.id));

  if (entry.kind === "pi.compaction" || entry.kind === "pi.reset") {
    const message = entry.model?.[0];

    return [
      {
        id: `${entryId}:0`,
        entryId,
        role: "event",
        kind: entry.kind === "pi.compaction" ? "compaction" : "reset",
        content:
          textOf(message?.content) ||
          (entry.kind === "pi.reset"
            ? "Conversation reset"
            : "Conversation compacted"),
        timestamp: message?.timestamp,
      },
    ];
  }

  const data = record(entry.data);

  if (entry.kind === "crumble.bot-message") {
    const parsed = botMessage.safeParse(entry.data);

    if (!parsed.success) return [];

    return [
      {
        id: `${entryId}:0`,
        entryId,
        role: "event",
        kind: "bot-message",
        content: parsed.data.content,
        timestamp: parsed.data.timestamp,
        communication: parsed.data.communication,
      },
    ];
  }

  if (entry.kind === GROUP_MESSAGE_KIND) {
    const parsed = groupMessageData.safeParse(entry.data);

    if (!parsed.success) return [];

    const { text, sender, requestId, timestamp, replyTo, replyPreview } =
      parsed.data;

    // Reactions take the shape of a bot chat's `react` result, attached to the message they answer.
    const message: TranscriptMessage =
      parsed.data.reaction === undefined
        ? {
            id: `${entryId}:0`,
            entryId,
            requestId,
            role: sender.kind === "owner" ? "user" : "assistant",
            content: text,
            timestamp,
            kind: entry.kind,
            origin: sender,
          }
        : {
            id: `${entryId}:0`,
            entryId,
            requestId,
            role: "toolResult",
            content: `Reacted ${parsed.data.reaction}`,
            timestamp,
            kind: entry.kind,
            origin: sender,
            toolName: REACTION_TOOL_NAME,
            toolDetails: { emoji: parsed.data.reaction },
          };

    if (replyTo !== undefined) message.replyTo = replyTo;

    if (replyPreview !== undefined) message.replyPreview = replyPreview;

    if (parsed.data.files?.length) message.attachments = parsed.data.files;

    return [message];
  }

  const input = inputMetadata.parse(data ?? {});
  const origin = originOf(data?.["origin"]);
  const attachments = attachmentsOf(data?.["attachments"]);

  return (entry.model ?? []).flatMap((message, index) => {
    // Reply inputs carry a quoted context block for the model; owners see the text they wrote.
    const content =
      entry.kind === "crumble.message" && input.text !== undefined
        ? input.text
        : textOf(message.content) || blockHint(message.content);

    const attached = message.role === "user" ? attachments : [];
    const metadata = toolMetadata.parse(message);

    if (
      !content &&
      !attached.length &&
      message.role !== "toolResult" &&
      metadata.toolCallId === undefined &&
      metadata.details === undefined
    )
      return [];

    const result: TranscriptMessage = {
      id: `${entryId}:${index}`,
      entryId,
      role: message.role,
      content,
      blocks: withoutImageData(message.content),
      timestamp: message.timestamp,
      kind: entry.kind,
    };

    if (message.role === "assistant") result.stopReason = message.stopReason;

    if (input.requestId) result.requestId = input.requestId;

    if (input.replyTo) {
      result.replyTo = input.replyTo;

      if (input.replyPreview !== undefined)
        result.replyPreview = input.replyPreview;
    }

    if (origin) result.origin = origin;

    if (attached.length) result.attachments = attached;

    if (metadata.toolCallId !== undefined)
      result.toolCallId = metadata.toolCallId;

    if (metadata.toolName !== undefined) result.toolName = metadata.toolName;

    if (metadata.isError !== undefined) result.isError = metadata.isError;

    if (metadata.details !== undefined) result.toolDetails = metadata.details;

    return [result];
  });
}

async function conversations(harness: Harness): Promise<ConversationRecord[]> {
  const records: ConversationRecord[] = [];
  let cursor: Cursor | undefined;

  do {
    const page = await harness.commit(
      (tx) => tx.scanConversations({}, 256, cursor),
      BACKGROUND_CONTEXT,
    );

    // Task-owned conversations, such as coding jobs, are the bot's internal work, not part of its chat.
    records.push(...page.items.filter((record) => !record.owner));
    cursor = page.next;
  } while (cursor);

  return records;
}

type PageOptions = { before?: string | undefined; limit?: number | undefined };

/** Newest-first page over the given conversations. Entry IDs are global, which makes them a shared cursor. */
async function readPage(
  agentId: string,
  sources: Conversation[],
  options: PageOptions,
): Promise<TranscriptPage> {
  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  const before =
    options.before === undefined
      ? undefined
      : parseEntryRef(agentId, options.before, "history cursor");

  const raw = new Map<number, EntryRecord>();
  let truncated = false;

  for (const conversation of sources) {
    const query: TranscriptEntryQuery = { order: "descending" };

    if (before !== undefined) {
      // SAFETY: parseEntryRef validated a positive safe integer; subtracting one
      // gives the inclusive entry bound immediately before that cursor.
      query.maxEntryId = (before - 1) as EntryId;
    }

    const page = await conversation.entries(
      query,
      limit + 1,
      undefined,
      BACKGROUND_CONTEXT,
    );

    for (const entry of page.items) raw.set(Number(entry.id), entry);
    truncated ||= page.next !== undefined;
  }

  const entries = [...raw.values()].sort((a, b) => Number(b.id) - Number(a.id));
  const messages: TranscriptMessage[] = [];
  let consumed = 0;

  // Pages end on entry boundaries so a cursor never splits one entry's messages.
  for (const entry of entries) {
    if (messages.length >= limit) break;
    messages.unshift(...normalize(agentId, entry));
    consumed += 1;
  }

  const oldest = consumed ? Number(entries[consumed - 1]!.id) : null;

  return {
    messages,
    hasMore: truncated || consumed < entries.length,
    oldestEntryId: oldest === null ? null : entryRef(agentId, oldest),
  };
}

/** Newest-first page of every chat conversation, so legacy sessions and the canonical chat read as one transcript. */
export async function readTranscript(
  harness: Harness,
  agentId: string,
  options: PageOptions = {},
): Promise<TranscriptPage> {
  const sources: Conversation[] = [];

  for (const item of await conversations(harness)) {
    const conversation = await harness.conversation(
      item.id,
      BACKGROUND_CONTEXT,
    );

    if (conversation) sources.push(conversation);
  }

  return readPage(agentId, sources, options);
}

/** Newest-first page of one conversation, such as a coding job, which the chat transcript leaves out. */
export async function readConversationTranscript(
  harness: Harness,
  agentId: string,
  conversationId: ConversationId,
  options: PageOptions = {},
): Promise<TranscriptPage> {
  const conversation = await harness.conversation(
    conversationId,
    BACKGROUND_CONTEXT,
  );

  return readPage(agentId, conversation ? [conversation] : [], options);
}

async function findOwner(
  harness: Harness,
  entryId: number,
): Promise<Conversation | undefined> {
  for (const item of await conversations(harness)) {
    const conversation = await harness.conversation(
      item.id,
      BACKGROUND_CONTEXT,
    );

    // SAFETY: entryId comes from parseEntryRef, which validates the persisted numeric ID.
    const page = await conversation?.entries(
      {
        order: "ascending",
        minEntryId: entryId as EntryId,
        maxEntryId: entryId as EntryId,
      },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    );

    if (page?.items.length) return conversation;
  }

  return undefined;
}

/** Bounds the target and its neighbours before admission so retries and restarts reuse one durable input. */
export async function prepareReply(
  harness: Harness,
  agentId: string,
  replyTo: string,
  content: string,
) {
  const target = parseEntryRef(agentId, replyTo, "reply target");
  const owner = await findOwner(harness, target);

  if (!owner) throw new Error("Reply target not found");

  // SAFETY: target is a validated entry ID; both bounds are positive integer offsets around it.
  const nearby = await owner.entries(
    {
      order: "ascending",
      minEntryId: Math.max(1, target - REPLY_WINDOW) as EntryId,
      maxEntryId: (target + REPLY_WINDOW) as EntryId,
    },
    REPLY_WINDOW * 2 + 1,
    undefined,
    BACKGROUND_CONTEXT,
  );

  const rows = nearby.items.flatMap((entry) =>
    normalize(agentId, entry)
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .map((message) => ({ entry, message })),
  );

  const at = rows.findIndex((row) => Number(row.entry.id) === target);

  if (at < 0) throw new Error("Reply target is not a visible message");
  const targetMessage = rows[at]!.message;

  const quoted = rows.slice(Math.max(0, at - 2), at + 3).map((row) => ({
    id: row.message.entryId,
    role: row.message.role,
    content: row.message.content.slice(
      0,
      row.message === targetMessage ? 6000 : 1500,
    ),
  }));

  while (JSON.stringify(quoted).length > 12000) {
    const longest = quoted.reduce((a, b) =>
      b.content.length > a.content.length ? b : a,
    );

    if (longest.content.length <= 80) break;
    longest.content = longest.content.slice(0, longest.content.length - 200);
  }

  return {
    modelContent: `<reply_context>\n${JSON.stringify(quoted)}\n</reply_context>\n\n${content}`,
    data: {
      text: content,
      replyTo,
      replyPreview: targetMessage.content.slice(0, 240),
      contextEntryIds: [...new Set(quoted.map((item) => item.id))],
    },
  };
}

/** The image at `index` of an input's attachments, read from the model message that carries it. */
export async function readAttachment(
  harness: Harness,
  agentId: string,
  entryRef: string,
  index: number,
): Promise<{ mimeType: string; data: Buffer }> {
  const target = parseEntryRef(agentId, entryRef, "attachment entry");
  const owner = await findOwner(harness, target);

  // SAFETY: target is the positive safe integer validated by parseEntryRef.
  const page = await owner?.entries(
    {
      order: "ascending",
      minEntryId: target as EntryId,
      maxEntryId: target as EntryId,
    },
    1,
    undefined,
    BACKGROUND_CONTEXT,
  );

  const entry = page?.items[0];

  if (!entry) throw new Error("Attachment not found");
  const attachments = attachmentsOf(record(entry.data)?.["attachments"]);

  if (attachments[index]?.kind !== "image")
    throw new Error("Attachment not found");

  // Image blocks follow the attachment order, so the nth image is the nth image attachment.
  const imageIndex = attachments
    .slice(0, index)
    .filter((item) => item.kind === "image").length;

  const content = entry.model?.[0]?.content;

  const images = Array.isArray(content)
    ? content.flatMap((block) => (block.type === "image" ? [block] : []))
    : [];

  const image = images[imageIndex];

  if (!image) throw new Error("Attachment not found");

  return { mimeType: image.mimeType, data: Buffer.from(image.data, "base64") };
}

/** Assistant output after one input, stopping at the next input so unrelated chat stays private. */
export async function readResponse(
  conversation: Conversation,
  inputEntryId: number,
): Promise<string[]> {
  // SAFETY: inputEntryId is the persisted input entry; its successor starts the response range.
  const page = await conversation.entries(
    { order: "ascending", minEntryId: (inputEntryId + 1) as EntryId },
    MAX_LIMIT,
    undefined,
    BACKGROUND_CONTEXT,
  );

  const output: string[] = [];

  for (const entry of page.items) {
    if (INPUT_KINDS.has(entry.kind)) break;

    for (const message of entry.model ?? []) {
      if (message.role === "assistant") {
        const text = textOf(message.content);

        if (text) output.push(text);
      }

      const { toolName, isError, details } = toolMetadata.parse(message);

      const reaction = reactionOf({
        role: message.role,
        toolName,
        isError,
        toolDetails: details,
      });

      if (reaction) output.push(`Reacted ${reaction}`);
    }
  }

  return output;
}

export type TurnReport = {
  /** Assistant messages that called tools: the turn's tool-activity rounds. */
  rounds: number;
  /** Rounds after the turn's last skill write, or null when it wrote none. */
  roundsSinceSkillWrite: number | null;
  /** Rounds after the turn's last memory write, or null when it wrote none. */
  roundsSinceMemoryWrite: number | null;
  /** The turn in plain text for a review, preceded by the chat before it, bounded by `maxChars`. */
  digest: string;
};

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const CONTEXT_ENTRIES = 40;

/** The memory tool's arguments when the call writes. */
const memoryWriteCall = z.object({
  action: z.enum(["create", "update", "delete"]),
});

type ToolCall = Extract<
  Extract<ModelContent, unknown[]>[number],
  { type: "toolCall" }
>;

function recordToolRound(calls: ToolCall[], counters: TurnReport): void {
  counters.rounds++;

  if (counters.roundsSinceSkillWrite !== null) counters.roundsSinceSkillWrite++;

  if (counters.roundsSinceMemoryWrite !== null)
    counters.roundsSinceMemoryWrite++;

  for (const call of calls) {
    if (call.name === "skill_manage") counters.roundsSinceSkillWrite = 0;

    const memoryWrite = memoryWriteCall.safeParse(call.arguments);

    if (call.name === "memory" && memoryWrite.success)
      counters.roundsSinceMemoryWrite = 0;
  }
}

function assistantLines(
  content: ModelContent,
  counters?: TurnReport,
): string[] {
  const lines: string[] = [];
  const text = textOf(content).trim();

  if (text) lines.push(`Assistant:\n${text}`);

  const calls = Array.isArray(content)
    ? content.filter((block) => block?.type === "toolCall")
    : [];

  if (calls.length && counters) recordToolRound(calls, counters);

  for (const call of calls)
    lines.push(
      `Tool call ${String(call.name ?? "unknown")}: ${clip(JSON.stringify(call.arguments ?? {}), 2000)}`,
    );

  return lines;
}

function toolResultLine(
  message: NonNullable<EntryRecord["model"]>[number],
): string {
  const { toolName, isError } = toolMetadata.parse(message);

  return `${isError ? "Tool error" : "Tool result"} ${toolName ?? "unknown"}: ${clip(textOf(message.content).trim(), 4000)}`;
}

function entryLines(entry: EntryRecord, counters?: TurnReport): string[] {
  const lines: string[] = [];

  if (INPUT_KINDS.has(entry.kind)) {
    const input = inputMetadata.parse(record(entry.data) ?? {});
    lines.push(`Owner:\n${input.text ?? textOf(entry.model?.[0]?.content)}`);

    return lines;
  }

  for (const message of entry.model ?? []) {
    if (message.role === "assistant") {
      lines.push(...assistantLines(message.content, counters));
    } else if (message.role === "toolResult") {
      lines.push(toolResultLine(message));
    } else if (message.role === "user") {
      const text = textOf(message.content).trim();

      if (text) lines.push(`Owner:\n${text}`);
    }
  }

  return lines;
}

/**
 * What a review needs to know about one turn: the turn itself in full, preceded by the chat before it for the
 * referents of corrections such as "use the previous format". The earlier chat gives way first when `maxChars`
 * binds, then the middle of the turn.
 */
export async function readTurnReport(
  conversation: Conversation,
  inputEntryId: number,
  maxChars: number,
): Promise<TurnReport> {
  // SAFETY: inputEntryId is the persisted input entry; the turn is that entry and everything up to the next input.
  const turnPage = await conversation.entries(
    { order: "ascending", minEntryId: inputEntryId as EntryId },
    MAX_LIMIT,
    undefined,
    BACKGROUND_CONTEXT,
  );

  const report: TurnReport = {
    rounds: 0,
    roundsSinceSkillWrite: null,
    roundsSinceMemoryWrite: null,
    digest: "",
  };

  const turnLines: string[] = [];

  for (const [index, entry] of turnPage.items.entries()) {
    if (index > 0 && INPUT_KINDS.has(entry.kind)) break;
    turnLines.push(...entryLines(entry, index > 0 ? report : undefined));
  }

  let turn = turnLines.join("\n\n");

  if (turn.length > maxChars) {
    // Keep the input and the end of the turn; the middle is usually tool output.
    const head = Math.floor(maxChars * 0.4);
    const tail = maxChars - head - 24;
    turn = `${turn.slice(0, head)}\n\n[… omitted for length …]\n\n${turn.slice(-tail)}`;
  }

  const room = maxChars - turn.length - 40;

  if (room > 200 && inputEntryId > 1) {
    // SAFETY: the entry before the input is the inclusive upper bound of the earlier chat.
    const earlier = await conversation.entries(
      { order: "descending", maxEntryId: (inputEntryId - 1) as EntryId },
      CONTEXT_ENTRIES,
      undefined,
      BACKGROUND_CONTEXT,
    );

    const contextLines = [...earlier.items]
      .reverse()
      .filter((entry) => INPUT_KINDS.has(entry.kind) || entry.model?.length)
      .flatMap((entry) => entryLines(entry));

    let context = contextLines.join("\n\n");

    if (context.length > room)
      context = `[… earlier chat omitted …]\n\n${context.slice(-room)}`;

    if (context)
      report.digest = `Earlier chat:\n\n${context}\n\nThe turn to review:\n\n${turn}`;
  }

  if (!report.digest) report.digest = `The turn to review:\n\n${turn}`;

  return report;
}

export type TurnOutcome =
  | { kind: "message"; text: string }
  | { kind: "reaction"; emoji: string }
  | { kind: "pass" };

/** A group turn's result after its input: a pass or reaction wins, else the final answer, else nothing. */
export async function readTurnOutcome(
  conversation: Conversation,
  inputEntryId: number,
): Promise<TurnOutcome> {
  // SAFETY: inputEntryId is the persisted input entry; its successor starts the response range.
  const page = await conversation.entries(
    { order: "ascending", minEntryId: (inputEntryId + 1) as EntryId },
    MAX_LIMIT,
    undefined,
    BACKGROUND_CONTEXT,
  );

  let text = "";

  for (const entry of page.items) {
    if (INPUT_KINDS.has(entry.kind)) break;

    for (const message of entry.model ?? []) {
      if (message.role === "assistant") text = textOf(message.content).trim();
      const { toolName, isError, details } = toolMetadata.parse(message);

      if (message.role !== "toolResult" || isError) continue;

      if (toolName === PASS_TOOL_NAME) return { kind: "pass" };

      const emoji = reactionOf({
        role: message.role,
        toolName,
        isError,
        toolDetails: details,
      });

      if (emoji) return { kind: "reaction", emoji };
    }
  }

  return text ? { kind: "message", text } : { kind: "pass" };
}
