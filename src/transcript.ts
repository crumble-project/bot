import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, Conversation } from "@earendil-works/pi-durable";
import type { EntryRecord, ConversationRecord } from "@earendil-works/pi-durable";

export type TranscriptMessage = {
  id: string;
  entryId: string;
  role: string;
  content: string;
  blocks?: unknown;
  timestamp?: number;
  kind?: string;
  replyTo?: string;
  origin?: { kind: string; name?: string; agentId?: string };
};

type ScanOptions = { before?: string; limit?: number };
type Found = { entry: EntryRecord; conversation: Conversation; messageIndex: number; message: TranscriptMessage };

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

function parseRef(agentId: string, value: string, label: string): number {
  const prefix = `${agentId}:`;
  if (!value.startsWith(prefix)) throw new Error(`${label} belongs to a different agent`);
  const raw = value.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`Invalid ${label}`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${label}`);
  return number;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string").map((b) => (b as { text: string }).text).join("\n");
}

function blockHint(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((b) => {
    if (!b || typeof b !== "object") return "";
    const x = b as { type?: unknown; name?: unknown; toolName?: unknown };
    if (x.type === "toolCall" || x.type === "tool_call") return `Tool call: ${String(x.name ?? x.toolName ?? "unknown")}`;
    if (x.type === "thinking") return "Thinking";
    if (x.type === "toolResult" || x.type === "tool_result") return "Tool result";
    return "";
  }).filter(Boolean).join("\n");
}

function ref(agentId: string, id: number): string { return `${agentId}:${id}`; }

function normalize(agentId: string, entry: EntryRecord): TranscriptMessage[] {
  const entryId = ref(agentId, Number(entry.id));
  const data = entry.data && typeof entry.data === "object" ? entry.data as Record<string, unknown> : undefined;
  if (entry.kind === "pi.compaction" || entry.kind === "pi.reset") {
    const content = textOf(entry.model?.[0]?.content) || (typeof data?.summary === "string" ? data.summary : entry.kind === "pi.reset" ? "Conversation reset" : "Conversation compacted");
    return content ? [{ id: `${entryId}:0`, entryId, role: "event", content, blocks: entry.model?.[0]?.content, kind: entry.kind === "pi.compaction" ? "compaction" : "reset", timestamp: typeof entry.model?.[0]?.timestamp === "number" ? entry.model[0].timestamp : undefined }] : [];
  }
  const model = entry.model ?? [];
  return model.map((message, index): TranscriptMessage | undefined => {
    const original = entry.kind === "crumble.message" && typeof data?.text === "string" ? data.text : textOf(message.content) || blockHint(message.content);
    if (!original) return undefined;
    const origin = data?.origin && typeof data.origin === "object" ? data.origin as Record<string, unknown> : undefined;
    return { id: `${entryId}:${index}`, entryId, role: message.role, content: original, blocks: message.content, timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined, kind: entry.kind, replyTo: typeof data?.replyTo === "string" ? data.replyTo : undefined, ...(origin && typeof origin.kind === "string" ? { origin: { kind: origin.kind, ...(typeof origin.name === "string" ? { name: origin.name } : {}), ...(typeof origin.agentId === "string" ? { agentId: origin.agentId } : {}) } } : {}) };
  }).filter((x): x is TranscriptMessage => x !== undefined);
}

async function conversations(harness: Harness): Promise<ConversationRecord[]> {
  const records: ConversationRecord[] = [];
  let cursor: Readonly<Record<string, import("@earendil-works/chord").JsonValue>> | undefined;
  do {
    const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), BACKGROUND_CONTEXT);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return records;
}

async function entriesFor(conversation: Conversation, before: number | undefined, needed: number): Promise<EntryRecord[]> {
  const all: EntryRecord[] = [];
  let cursor: Readonly<Record<string, import("@earendil-works/chord").JsonValue>> | undefined;
  do {
    const page = await conversation.entries({ order: "descending", ...(before === undefined ? {} : { maxEntryId: before - 1 as never }) }, Math.max(needed, 1), cursor, BACKGROUND_CONTEXT);
    all.push(...page.items);
    cursor = page.next;
    if (!cursor && all.length >= needed) break;
  } while (cursor);
  return all;
}

export async function readTranscript(harness: Harness, agentId: string, options: ScanOptions = {}) {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const before = options.before === undefined ? undefined : parseRef(agentId, options.before, "before cursor");
  const raw: EntryRecord[] = [];
  for (const record of await conversations(harness)) {
    const conversation = await harness.conversation(record.id, BACKGROUND_CONTEXT);
    if (conversation) raw.push(...await entriesFor(conversation, before, limit + 1));
  }
  const deduped = [...new Map(raw.map((entry) => [Number(entry.id), entry])).values()].sort((a, b) => Number(b.id) - Number(a.id));
  const display = deduped.flatMap((entry) => normalize(agentId, entry).map((message) => ({ entry, message })));
  const selected = display.slice(0, limit);
  const oldestRaw = selected.length ? Number(selected[selected.length - 1]!.entry.id) : deduped.length ? Number(deduped[deduped.length - 1]!.id) : null;
  return { messages: selected.map((x) => x.message).reverse(), hasMore: display.length > limit || deduped.some((x) => Number(x.id) < (oldestRaw ?? Infinity)), oldestEntryId: oldestRaw === null ? null : ref(agentId, oldestRaw) };
}

export async function prepareReply(harness: Harness, agentId: string, replyTo: string, content: string) {
  const match = replyTo.match(/^(.*):([1-9][0-9]*):([0-9]+)$/);
  if (!match || match[1] !== agentId || !Number.isSafeInteger(Number(match[2])) || !Number.isSafeInteger(Number(match[3]))) throw new Error("Invalid reply target");
  const targetEntry = Number(match[2]);
  const targetIndex = Number(match[3]);
  const raw: EntryRecord[] = [];
  for (const record of await conversations(harness)) {
    const conversation = await harness.conversation(record.id, BACKGROUND_CONTEXT);
    if (conversation) raw.push(...await entriesFor(conversation, undefined, MAX_LIMIT + 1));
  }
  const entries = [...new Map(raw.map((e) => [Number(e.id), e])).values()].sort((a, b) => Number(a.id) - Number(b.id));
  const rows: Found[] = entries.flatMap((entry) => normalize(agentId, entry).filter((message) => message.role !== "event" && message.role !== "system").map((message, index) => ({ entry, conversation: undefined as never, messageIndex: index, message })));
  const target = rows.find((x) => x.entry.id === targetEntry && x.message.id === replyTo && x.messageIndex === targetIndex);
  if (!target || target.message.role === "event" || target.entry.kind.startsWith("pi.")) throw new Error("Reply target is not a visible message");
  const at = rows.indexOf(target);
  const nearby = rows.slice(Math.max(0, at - 2), at + 3);
  const quoted = nearby.map((x) => ({ id: x.message.id, role: x.message.role, content: x.message === target.message ? x.message.content.slice(0, 6000) : x.message.content.slice(0, 1500) }));
  let json = JSON.stringify(quoted);
  if (json.length > 12000) json = json.slice(0, 11997) + "...";
  return { modelContent: `<reply_context>\n${json}\n</reply_context>\n\n${content}`, data: { text: content, replyTo, contextEntryIds: nearby.map((x) => x.message.entryId), replyPreview: target.message.content.slice(0, 240) } };
}
