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

import type { AttachmentInfo } from "../shared/attachment-rules";
import {
  formatEntryId,
  formatMessageId,
  parseEntryId,
} from "../shared/entry-ids";
import { JOB_KINDS, jobKindTitle } from "../jobs/job-kinds";
import {
  ASSISTANT_ENTRY,
  attachmentInfo,
  BOT_MESSAGE_ENTRY,
  botMessage,
  contentText,
  GROUP_MESSAGE_ENTRY,
  groupMessageData,
  HELD_ACTION_ENTRY,
  heldActionData,
  inputMetadata,
  jobCardName,
  JOB_QUESTION_ENTRY,
  jobQuestionData,
  MESSAGE_ENTRY,
  messageOrigin,
  USER_ENTRY,
  type GroupMessageData,
  type MessageOrigin,
  type ModelContent,
} from "./entries";
import { reactionOf } from "./reaction";
import {
  DESKTOP_SCREENSHOT_TOOL_NAME,
  REACTION_TOOL_NAME,
} from "../contract/tools";
import type { BotCommunication } from "../contract/api-responses";
import type { WebSource } from "../contract/web-search";
import { MESSAGE_PREVIEW_CHARS } from "../shared/limits";

type TranscriptEntryQuery = { order: "descending"; maxEntryId?: EntryId };

const textBlock = z.object({ type: z.literal("text"), text: z.string() });

const toolBlock = z.object({
  type: z.unknown().optional(),
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  arguments: z.unknown().optional(),
  toolCallId: z.unknown().optional(),
  content: z.unknown().optional(),
  isError: z.unknown().optional(),
});

const jsonRecord = z.record(z.string(), z.json());

export const toolMetadata = z.object({
  toolCallId: z.string().optional().catch(undefined),
  toolName: z.string().optional().catch(undefined),
  isError: z.boolean().optional().catch(undefined),
  details: z.unknown().optional(),
});

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
  /** On a `job-question` event: the job that asked the owner. */
  jobQuestion?: {
    id: string;
    kind: string;
    job: string;
    options?: string[];
    multiple?: boolean;
  };
  /** On a `held-action` event: the desktop job action waiting for the owner. */
  heldAction?: { id: string; job: string };
  attachments?: AttachmentInfo[];
  /** Tool result metadata is carried on the model message, rather than its content blocks. */
  toolCallId?: string;
  toolName?: string | undefined;
  isError?: boolean | undefined;
  /** Provider-specific details, including codemode nested tool calls. */
  toolDetails?: unknown;
  /** A group message's pages that its bot searched or read. */
  sources?: WebSource[];
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

function eventLabel(message: TranscriptMessage): string {
  const reaction = reactionOf(message);

  if (reaction) return `Reacted ${reaction}`;

  for (const kind of Object.values(JOB_KINDS)) {
    const job = jobCardName(kind.toolName, message);

    if (job) return `${jobKindTitle(kind)} ${job}`;
  }

  return message.role === "toolResult" &&
    message.toolName === DESKTOP_SCREENSHOT_TOOL_NAME &&
    !message.isError
    ? "Desktop screenshot"
    : "";
}

function conversationPreview(message: TranscriptMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  const text = message.content.trim();

  if (text && hasTextBlock(message))
    return text.slice(0, MESSAGE_PREVIEW_CHARS);
  const attachment = message.attachments?.[0];

  return attachment ? `Attachment: ${attachment.name}` : "";
}

function previewOf(message: TranscriptMessage): string {
  const botText =
    message.kind === "bot-message"
      ? message.content.trim().slice(0, MESSAGE_PREVIEW_CHARS)
      : "";

  return botText || eventLabel(message) || conversationPreview(message);
}

/** Short, user-facing text for an agent list/sidebar. Structural tool and thinking blocks are excluded. */
export function latestMessagePreview(messages: TranscriptMessage[]): string {
  for (const message of [...messages].reverse()) {
    const preview = previewOf(message);

    if (preview) return preview;
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

/** Words Crumble admitted for the owner, whose metadata text is what they wrote. */
export const isOwnerInput = (message: TranscriptMessage) =>
  message.kind === MESSAGE_ENTRY &&
  message.role === "user" &&
  message.origin?.kind !== "bot";

/** Plain model turns: the assistant's, and a user's that no other bot sent. */
export const isConversational = (message: TranscriptMessage) =>
  (message.kind === ASSISTANT_ENTRY && message.role === "assistant") ||
  (message.kind === USER_ENTRY &&
    message.role === "user" &&
    message.origin?.kind !== "bot");

const blocksOf = (message: TranscriptMessage) =>
  z.array(z.unknown()).safeParse(message.blocks).data;

/** A message's text blocks, one per line; a user's plain string; null for anything else. */
export function textOf(message: TranscriptMessage): string | null {
  const blocks = blocksOf(message);

  if (blocks)
    return blocks
      .flatMap((block) => {
        const parsed = textBlock.safeParse(block);

        return parsed.success ? [parsed.data.text] : [];
      })
      .join("\n");

  if (message.role !== "user") return null;

  return z.string().safeParse(message.blocks).data ?? null;
}

/** A provider's tool call or result block, by its position in the message; unreadable fields are unset. */
export type ToolBlock =
  | {
      type: "toolCall";
      index: number;
      id: string | undefined;
      name: string | undefined;
      arguments: JsonValue | undefined;
    }
  | {
      type: "toolResult";
      index: number;
      toolCallId: string | undefined;
      content: JsonValue | undefined;
      isError: boolean | undefined;
    };

export function toolBlocks(message: TranscriptMessage): ToolBlock[] {
  return (blocksOf(message) ?? []).flatMap((raw, index): ToolBlock[] => {
    const block = toolBlock.safeParse(raw).data;

    if (block?.type === "toolCall")
      return [
        {
          type: "toolCall",
          index,
          id: z.string().safeParse(block.id).data,
          name: z.string().safeParse(block.name).data,
          arguments: z.json().safeParse(block.arguments).data,
        },
      ];

    if (block?.type === "toolResult")
      return [
        {
          type: "toolResult",
          index,
          toolCallId: z.string().safeParse(block.toolCallId).data,
          content: z.json().safeParse(block.content).data,
          isError: z.boolean().safeParse(block.isError).data,
        },
      ];

    return [];
  });
}

export const toolCalls = (message: TranscriptMessage) =>
  toolBlocks(message).filter((block) => block.type === "toolCall");

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;
const REPLY_WINDOW = 20;
const INPUT_KINDS = new Set<string>([MESSAGE_ENTRY, USER_ENTRY]);

/** An entry that starts a turn. */
export const isInputEntry = (entry: EntryRecord) => INPUT_KINDS.has(entry.kind);

export function parseEntryRef(
  agentId: string,
  value: string,
  label: string,
): number {
  const entry = parseEntryId(value, agentId);

  if (entry === "foreign")
    throw new Error(`${label} belongs to a different agent`);

  if (entry === "malformed") throw new Error(`Invalid ${label}`);

  return entry;
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

export function record(value: JsonValue | undefined) {
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

function normalizeBoundary(
  entryId: string,
  entry: EntryRecord,
): TranscriptMessage[] {
  const message = entry.model?.[0];

  return [
    {
      id: formatMessageId(entryId, 0),
      entryId,
      role: "event",
      kind: entry.kind === "pi.compaction" ? "compaction" : "reset",
      content:
        contentText(message?.content) ||
        (entry.kind === "pi.reset"
          ? "Conversation reset"
          : "Conversation compacted"),
      timestamp: message?.timestamp,
    },
  ];
}

function normalizeBotMessage(
  entryId: string,
  entry: EntryRecord,
): TranscriptMessage[] {
  const parsed = botMessage.safeParse(entry.data);

  if (!parsed.success) return [];

  return [
    {
      id: formatMessageId(entryId, 0),
      entryId,
      role: "event",
      kind: "bot-message",
      content: parsed.data.content,
      timestamp: parsed.data.timestamp,
      communication: parsed.data.communication,
    },
  ];
}

function normalizeJobQuestion(
  entryId: string,
  entry: EntryRecord,
): TranscriptMessage[] {
  const parsed = jobQuestionData.safeParse(entry.data);

  if (!parsed.success) return [];
  const { id, kind, job, text, timestamp, options, multiple } = parsed.data;

  return [
    {
      id: formatMessageId(entryId, 0),
      entryId,
      role: "event",
      kind: "job-question",
      content: text,
      timestamp,
      jobQuestion: {
        id,
        kind,
        job,
        ...(options && { options }),
        ...(multiple && { multiple }),
      },
    },
  ];
}

function normalizeHeldAction(
  entryId: string,
  entry: EntryRecord,
): TranscriptMessage[] {
  const parsed = heldActionData.safeParse(entry.data);

  if (!parsed.success) return [];

  return [
    {
      id: formatMessageId(entryId, 0),
      entryId,
      role: "event",
      kind: "held-action",
      content: parsed.data.action,
      timestamp: parsed.data.timestamp,
      heldAction: { id: parsed.data.id, job: parsed.data.job },
    },
  ];
}

function normalizeGroupMessage(
  entryId: string,
  entry: EntryRecord,
): TranscriptMessage[] {
  const parsed = groupMessageData.safeParse(entry.data);

  if (!parsed.success) return [];

  const { text, sender, requestId, timestamp, replyTo, replyPreview } =
    parsed.data;

  // Reactions take the shape of a bot chat's `react` result, attached to the message they answer.
  const message: TranscriptMessage =
    parsed.data.reaction === undefined
      ? {
          id: formatMessageId(entryId, 0),
          entryId,
          requestId,
          role: sender.kind === "owner" ? "user" : "assistant",
          content: text,
          timestamp,
          kind: entry.kind,
          origin: sender,
        }
      : {
          id: formatMessageId(entryId, 0),
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

  addGroupExtras(message, parsed.data);

  return [message];
}

function addGroupExtras(message: TranscriptMessage, data: GroupMessageData) {
  if (data.files?.length) message.attachments = data.files;

  if (data.sources?.length) message.sources = data.sources;
}

export type ModelMessage = NonNullable<EntryRecord["model"]>[number];

type ToolMetadata = ReturnType<typeof toolMetadata.parse>;

function emptyMessage(
  message: ModelMessage,
  content: string,
  attached: AttachmentInfo[],
  metadata: ToolMetadata,
) {
  return (
    !content &&
    !attached.length &&
    message.role !== "toolResult" &&
    metadata.toolCallId === undefined &&
    metadata.details === undefined
  );
}

function applyToolMetadata(result: TranscriptMessage, metadata: ToolMetadata) {
  if (metadata.toolCallId !== undefined)
    result.toolCallId = metadata.toolCallId;

  if (metadata.toolName !== undefined) result.toolName = metadata.toolName;

  if (metadata.isError !== undefined) result.isError = metadata.isError;

  if (metadata.details !== undefined) result.toolDetails = metadata.details;
}

function applyInputMetadata(
  result: TranscriptMessage,
  input: ReturnType<typeof inputMetadata.parse>,
) {
  if (input.requestId) result.requestId = input.requestId;

  if (!input.replyTo) return;
  result.replyTo = input.replyTo;

  if (input.replyPreview !== undefined)
    result.replyPreview = input.replyPreview;
}

function normalizeModelEntry(
  entryId: string,
  entry: EntryRecord,
): TranscriptMessage[] {
  const data = record(entry.data);
  const input = inputMetadata.parse(data ?? {});
  const origin = originOf(data?.["origin"]);
  const attachments = attachmentsOf(data?.["attachments"]);

  return (entry.model ?? []).flatMap((message, index) => {
    // Reply inputs carry a quoted context block for the model; owners see the text they wrote.
    const content =
      entry.kind === MESSAGE_ENTRY && input.text !== undefined
        ? input.text
        : contentText(message.content) || blockHint(message.content);

    const attached = message.role === "user" ? attachments : [];
    const metadata = toolMetadata.parse(message);

    if (emptyMessage(message, content, attached, metadata)) return [];

    const result: TranscriptMessage = {
      id: formatMessageId(entryId, index),
      entryId,
      role: message.role,
      content,
      blocks: withoutImageData(message.content),
      timestamp: message.timestamp,
      kind: entry.kind,
    };

    if (message.role === "assistant") result.stopReason = message.stopReason;
    applyInputMetadata(result, input);

    if (origin) result.origin = origin;

    if (attached.length) result.attachments = attached;
    applyToolMetadata(result, metadata);

    return [result];
  });
}

function normalize(agentId: string, entry: EntryRecord): TranscriptMessage[] {
  const entryId = formatEntryId(agentId, Number(entry.id));

  if (entry.kind === "pi.compaction" || entry.kind === "pi.reset")
    return normalizeBoundary(entryId, entry);

  if (entry.kind === BOT_MESSAGE_ENTRY)
    return normalizeBotMessage(entryId, entry);

  if (entry.kind === GROUP_MESSAGE_ENTRY)
    return normalizeGroupMessage(entryId, entry);

  if (entry.kind === HELD_ACTION_ENTRY)
    return normalizeHeldAction(entryId, entry);

  if (entry.kind === JOB_QUESTION_ENTRY)
    return normalizeJobQuestion(entryId, entry);

  return normalizeModelEntry(entryId, entry);
}

/** The conversations of a bot's chat, oldest first. */
export async function conversations(
  harness: Harness,
): Promise<ConversationRecord[]> {
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

export type PageOptions = {
  before?: string | undefined;
  limit?: number | undefined;
};

const pageLimit = (limit: number | undefined) =>
  Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

async function collectEntries(
  sources: Conversation[],
  limit: number,
  before: number | undefined,
) {
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

  return { entries, truncated };
}

/** Newest-first page over the given conversations. Entry IDs are global, which makes them a shared cursor. */
async function readPage(
  agentId: string,
  sources: Conversation[],
  options: PageOptions,
): Promise<TranscriptPage> {
  const limit = pageLimit(options.limit);

  const before =
    options.before === undefined
      ? undefined
      : parseEntryRef(agentId, options.before, "history cursor");

  const { entries, truncated } = await collectEntries(sources, limit, before);
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
    oldestEntryId: oldest === null ? null : formatEntryId(agentId, oldest),
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
      replyPreview: targetMessage.content.slice(0, MESSAGE_PREVIEW_CHARS),
      contextEntryIds: [...new Set(quoted.map((item) => item.id))],
    },
  };
}

/**
 * The image at `index` of an input's attachments or of a desktop screenshot the bot showed, read from the model message
 * that carries it.
 */
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
  const image = inputImage(entry, index) ?? screenshotImage(entry, index);

  if (!image) throw new Error("Attachment not found");

  return { mimeType: image.mimeType, data: Buffer.from(image.data, "base64") };
}

const imagesOf = (content: ModelContent | undefined) =>
  Array.isArray(content)
    ? content.flatMap((block) => (block.type === "image" ? [block] : []))
    : [];

/** The image at `index` of an input's attachments. */
function inputImage(entry: EntryRecord, index: number) {
  const attachments = attachmentsOf(record(entry.data)?.["attachments"]);

  if (attachments[index]?.kind !== "image") return undefined;

  // Image blocks follow the attachment order, so the nth image is the nth image attachment.
  const imageIndex = attachments
    .slice(0, index)
    .filter((item) => item.kind === "image").length;

  return imagesOf(entry.model?.[0]?.content)[imageIndex];
}

/** The image at `index` of a successful `desktop_screenshot` result: the screen the bot showed the owner. */
function screenshotImage(entry: EntryRecord, index: number) {
  const message = entry.model?.[0];

  if (message?.role !== "toolResult") return undefined;
  const { toolName, isError } = toolMetadata.parse(message);

  if (toolName !== DESKTOP_SCREENSHOT_TOOL_NAME || isError) return undefined;

  return imagesOf(message.content)[index];
}

function outputLines(message: ModelMessage): string[] {
  const lines: string[] = [];
  const text = message.role === "assistant" ? contentText(message.content) : "";

  if (text) lines.push(text);
  const { toolName, isError, details } = toolMetadata.parse(message);

  const reaction = reactionOf({
    role: message.role,
    toolName,
    isError,
    toolDetails: details,
  });

  if (reaction) lines.push(`Reacted ${reaction}`);

  return lines;
}

/** A page of the entries from `first` on, for reading a turn. */
export async function entriesFrom(conversation: Conversation, first: number) {
  // SAFETY: `first` is a persisted entry ID or its successor, so it is a valid inclusive lower bound.
  const page = await conversation.entries(
    { order: "ascending", minEntryId: first as EntryId },
    MAX_LIMIT,
    undefined,
    BACKGROUND_CONTEXT,
  );

  return page.items;
}

/** The newest `limit` entries before `next`, for reading what came before a turn. */
export async function entriesBefore(
  conversation: Conversation,
  next: number,
  limit: number,
) {
  // SAFETY: the entry before a persisted input is the inclusive upper bound of what preceded it.
  const page = await conversation.entries(
    { order: "descending", maxEntryId: (next - 1) as EntryId },
    limit,
    undefined,
    BACKGROUND_CONTEXT,
  );

  return page.items;
}

/** Assistant output after one input, stopping at the next input so unrelated chat stays private. */
export async function readResponse(
  conversation: Conversation,
  inputEntryId: number,
): Promise<string[]> {
  const output: string[] = [];

  for (const entry of await entriesFrom(conversation, inputEntryId + 1)) {
    if (isInputEntry(entry)) break;

    for (const message of entry.model ?? [])
      output.push(...outputLines(message));
  }

  return output;
}
