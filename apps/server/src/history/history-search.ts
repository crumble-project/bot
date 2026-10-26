import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  GROUP_MESSAGE_KIND,
  type MessageOrigin,
  type TranscriptMessage,
  type TranscriptPage,
} from "../bots/transcript";

export type HistoryContext = { agentId: string; groupId: string | null };

export type HistoryChat = { id: string; kind: "bot" | "group"; name: string };

export type HistorySource = {
  chats(context: HistoryContext): Promise<HistoryChat[]>;
  page(
    context: HistoryContext,
    chat: HistoryChat,
    before?: string,
  ): Promise<TranscriptPage>;
};

export type HistorySender = {
  role: string;
  name: string;
  agentId?: string;
  origin?: MessageOrigin;
};

export type HistorySearchMatch = {
  match: string;
  chat: HistoryChat;
  messageId: string;
  entryId: string;
  sender: HistorySender;
  timestamp: number | null;
  excerpt: string;
  truncated: boolean;
};

export type HistorySearchResult = {
  matches: HistorySearchMatch[];
  cursor: string | null;
};

export type HistoryReadMessage = {
  messageId: string;
  entryId: string;
  sender: HistorySender;
  timestamp: number | null;
  text: string;
  truncated: boolean;
  offset: number;
  totalCodePoints: number;
};

export type HistoryReadResult = {
  chat: HistoryChat;
  messages: HistoryReadMessage[];
  before: string | null;
  after: string | null;
  beginning: boolean;
  end: boolean;
  omittedToolActivity: boolean;
};

const snapshotSchema = z.object({
  chat: z.object({
    id: z.string(),
    kind: z.enum(["bot", "group"]),
    name: z.string(),
  }),
  cutoff: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const positionSchema = z.object({
  messageId: z.string(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const keySchema = z.object({
  timestamp: z.number().nullable(),
  chatId: z.string(),
  entry: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: z.string(),
});

const caller = {
  agentId: z.string(),
  groupId: z.string().nullable(),
};

const tokenSchema = z.discriminatedUnion("type", [
  z.object({
    ...caller,
    type: z.literal("search"),
    query: z.string(),
    snapshots: z.array(snapshotSchema),
    last: keySchema,
  }),
  z.object({
    ...caller,
    type: z.literal("match"),
    snapshot: snapshotSchema,
    messageId: z.string(),
  }),
  z.object({
    ...caller,
    type: z.literal("read"),
    snapshot: snapshotSchema,
    position: positionSchema,
    direction: z.enum(["before", "after"]),
  }),
]);

const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });
const toolCallSchema = z.object({ type: z.literal("toolCall") });

type Snapshot = z.infer<typeof snapshotSchema>;

type Position = z.infer<typeof positionSchema>;

type MatchKey = z.infer<typeof keySchema>;

type Token = z.infer<typeof tokenSchema>;

type MatchToken = Extract<Token, { type: "match" }>;

type ReadToken = Extract<Token, { type: "read" }>;

type Direction = "before" | "after";

type Row = {
  original: TranscriptMessage;
  entry: number;
  index: number;
  body: string | null;
  toolActivity: boolean;
};

type Candidate = { snapshot: Snapshot; row: Row; key: MatchKey };

type Window = {
  messages: HistoryReadMessage[];
  start: Position;
  finish: Position;
};

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function entryNumber(chat: HistoryChat, entryId: string): number {
  const prefix = `${chat.id}:`;
  const suffix = entryId.slice(prefix.length);
  const entry = Number(suffix);

  if (
    !entryId.startsWith(prefix) ||
    !/^[1-9][0-9]*$/.test(suffix) ||
    !Number.isSafeInteger(entry)
  )
    throw new Error("History source returned an invalid entry identifier");

  return entry;
}

function messageIndex(entryId: string, messageId: string): number {
  const prefix = `${entryId}:`;
  const suffix = messageId.slice(prefix.length);
  const index = Number(suffix);

  if (
    !messageId.startsWith(prefix) ||
    !/^(0|[1-9][0-9]*)$/.test(suffix) ||
    !Number.isSafeInteger(index)
  )
    throw new Error("History source returned an invalid message identifier");

  return index;
}

function blockList(message: TranscriptMessage): unknown[] | null {
  const blocks = z.array(z.unknown()).safeParse(message.blocks);

  return blocks.success ? blocks.data : null;
}

function hasToolCall(blocks: unknown[] | null): boolean {
  return (
    blocks?.some((block) => toolCallSchema.safeParse(block).success) ?? false
  );
}

function toolActivityOf(
  chat: HistoryChat,
  message: TranscriptMessage,
  blocks: unknown[] | null,
): boolean {
  if (chat.kind !== "bot") return false;

  if (message.role === "toolResult") return true;

  return message.kind === "pi.assistant" && hasToolCall(blocks);
}

function groupBody(message: TranscriptMessage): string | null {
  if (message.kind !== GROUP_MESSAGE_KIND) return null;

  if (message.role !== "user" && message.role !== "assistant") return null;

  if (message.origin?.kind !== "owner" && message.origin?.kind !== "bot")
    return null;

  return message.content;
}

function isOwnerMessage(message: TranscriptMessage): boolean {
  if (message.kind !== "crumble.message" || message.role !== "user")
    return false;

  return message.origin?.kind !== "bot";
}

function isConversational(message: TranscriptMessage): boolean {
  if (message.kind === "pi.assistant" && message.role === "assistant")
    return true;

  return (
    message.kind === "pi.user" &&
    message.role === "user" &&
    message.origin?.kind !== "bot"
  );
}

function textBody(
  message: TranscriptMessage,
  blocks: unknown[] | null,
): string | null {
  if (blocks)
    return blocks
      .flatMap((block) => {
        const parsed = textBlockSchema.safeParse(block);

        return parsed.success ? [parsed.data.text] : [];
      })
      .join("\n");

  if (message.role !== "user") return null;

  const text = z.string().safeParse(message.blocks);

  return text.success ? text.data : null;
}

function bodyOf(
  chat: HistoryChat,
  message: TranscriptMessage,
  blocks: unknown[] | null,
): string | null {
  if (chat.kind === "group") return groupBody(message);

  // Reply context lives in blocks; normalize preserves the owner's metadata text in content.
  if (isOwnerMessage(message)) return message.content;

  if (!isConversational(message)) return null;

  return textBody(message, blocks);
}

function rowOf(chat: HistoryChat, message: TranscriptMessage): Row {
  const entry = entryNumber(chat, message.entryId);
  const index = messageIndex(message.entryId, message.id);
  const blocks = blockList(message);

  return {
    original: message,
    entry,
    index,
    body: bodyOf(chat, message, blocks),
    toolActivity: toolActivityOf(chat, message, blocks),
  };
}

function timestamp(message: TranscriptMessage): number | null {
  return message.timestamp !== undefined && Number.isFinite(message.timestamp)
    ? message.timestamp
    : null;
}

function sender(chat: HistoryChat, message: TranscriptMessage): HistorySender {
  const origin = message.origin;

  const result: HistorySender = {
    role: message.role,
    name:
      origin?.name ||
      (message.role === "user" ? "Owner" : origin?.agentId || chat.name),
  };

  if (origin?.agentId) result.agentId = origin.agentId;
  else if (chat.kind === "bot" && message.role === "assistant")
    result.agentId = chat.id;

  if (origin) result.origin = origin;

  return result;
}

function keyOf(chat: HistoryChat, row: Row): MatchKey {
  return {
    timestamp: timestamp(row.original),
    chatId: chat.id,
    entry: row.entry,
    index: row.index,
    id: row.original.id,
  };
}

// Undated originals remain undated; they sort after dated messages.
function compareTimestamps(a: MatchKey, b: MatchKey): number {
  if (a.timestamp === b.timestamp) return 0;

  if (a.timestamp === null) return 1;

  if (b.timestamp === null) return -1;

  return b.timestamp - a.timestamp;
}

function compareKeys(a: MatchKey, b: MatchKey): number {
  return (
    compareTimestamps(a, b) ||
    ordinal(a.chatId, b.chatId) ||
    b.entry - a.entry ||
    b.index - a.index ||
    ordinal(a.id, b.id)
  );
}

function excerpt(body: string, query: string) {
  const match = body.toLowerCase().indexOf(query.toLowerCase());
  const points = Array.from(body);
  let offset = 0;
  let lowered = 0;

  while (offset < points.length && lowered < match) {
    lowered += points[offset]!.toLowerCase().length;
    offset += 1;
  }

  const start = Math.max(0, offset - (lowered > match ? 1 : 0));

  return {
    excerpt: points.slice(start, start + 500).join(""),
    truncated: start > 0 || start + 500 < points.length,
  };
}

function messagePart(
  chat: HistoryChat,
  row: Row,
  points: string[],
  start: number,
  finish: number,
): HistoryReadMessage {
  return {
    messageId: row.original.id,
    entryId: row.original.entryId,
    sender: sender(chat, row.original),
    timestamp: timestamp(row.original),
    text: points.slice(start, finish).join(""),
    truncated: start > 0 || finish < points.length,
    offset: start,
    totalCodePoints: points.length,
  };
}

function positionIndex(rows: Row[], position: Position): number {
  const index = rows.findIndex((row) => row.original.id === position.messageId);

  if (index < 0 || position.offset > Array.from(rows[index]!.body ?? "").length)
    throw new Error(
      "History message is no longer available; start a new search",
    );

  return index;
}

function validQuery(query: string | undefined): string {
  if (query === undefined || !query.trim() || Array.from(query).length > 500)
    throw new Error(
      "History query must contain non-whitespace text and at most 500 Unicode code points",
    );

  return query;
}

function pageCutoff(chat: HistoryChat, page: TranscriptPage): number {
  let cutoff =
    page.oldestEntryId === null ? 0 : entryNumber(chat, page.oldestEntryId);

  for (const message of page.messages)
    cutoff = Math.max(cutoff, entryNumber(chat, message.entryId));

  if (page.hasMore && page.oldestEntryId === null)
    throw new Error("History source did not provide a complete page cursor");

  return cutoff;
}

function isAvailable(available: HistoryChat[], chat: HistoryChat): boolean {
  return available.some(
    (candidate) => candidate.id === chat.id && candidate.kind === chat.kind,
  );
}

function matchesIn(
  snapshot: Snapshot,
  rows: Row[],
  query: string,
  last: MatchKey | undefined,
): Candidate[] {
  const lowered = query.toLowerCase();
  const candidates: Candidate[] = [];

  for (const row of rows) {
    if (!row.body || !row.body.toLowerCase().includes(lowered)) continue;

    const key = keyOf(snapshot.chat, row);

    if (!last || compareKeys(key, last) > 0)
      candidates.push({ snapshot, row, key });
  }

  return candidates;
}

function invalidDirection(direction: Direction | undefined): boolean {
  return (
    direction !== undefined && direction !== "before" && direction !== "after"
  );
}

function readRequest(args: {
  match?: string;
  cursor?: string;
  direction?: Direction;
}) {
  if ((args.match === undefined) === (args.cursor === undefined))
    throw new Error("Provide exactly one history match or read cursor");

  if (invalidDirection(args.direction))
    throw new Error("Invalid history read direction");

  return {
    token: args.match ?? args.cursor ?? "",
    match: args.match,
    cursor: args.cursor,
  };
}

function narrowToken(
  token: Token,
  request: { match: string | undefined; cursor: string | undefined },
): MatchToken | ReadToken {
  if (token.type === "search")
    throw new Error("Expected a history match or read cursor");

  if (request.match !== undefined && token.type !== "match")
    throw new Error("Expected a history match or read cursor");

  if (request.cursor !== undefined && token.type !== "read")
    throw new Error("Expected a history match or read cursor");

  return token;
}

function pageCursor(chat: HistoryChat, page: TranscriptPage): number | null {
  return page.oldestEntryId === null
    ? null
    : entryNumber(chat, page.oldestEntryId);
}

function addPageRows(
  chat: HistoryChat,
  page: TranscriptPage,
  cutoff: number,
  seen: Set<string>,
  rows: Row[],
): void {
  // Every message is validated before any overlap check, so a malformed page reports its invalid identifier.
  const pageRows = page.messages.map((message) => rowOf(chat, message));

  for (const row of pageRows) {
    if (row.entry > cutoff) continue;

    if (seen.has(row.original.id))
      throw new Error("History source returned overlapping pages");

    seen.add(row.original.id);
    rows.push(row);
  }
}

function nextCursor(
  chat: HistoryChat,
  before: string | undefined,
  oldest: number | null,
  oldestEntryId: string | null,
): string | undefined {
  if (
    oldest === null ||
    (before !== undefined && oldest >= entryNumber(chat, before))
  )
    throw new Error("History source did not provide a complete page cursor");

  return oldestEntryId ?? undefined;
}

function windowAfter(
  chat: HistoryChat,
  rows: Row[],
  position: Position,
  count: number,
  budget: number,
): Window {
  let index = positionIndex(rows, position);
  let offset = position.offset;
  let boundary = position;
  const messages: HistoryReadMessage[] = [];

  while (
    index >= 0 &&
    index < rows.length &&
    messages.length < count &&
    budget > 0
  ) {
    const row = rows[index]!;
    const points = Array.from(row.body ?? "");

    if (offset < points.length) {
      const finish = Math.min(points.length, offset + budget);

      messages.push(messagePart(chat, row, points, offset, finish));
      budget -= finish - offset;
      boundary = { messageId: row.original.id, offset: finish };

      if (finish < points.length) break;
    }

    index += 1;
    offset = 0;
  }

  return { messages, start: position, finish: boundary };
}

function windowBefore(
  chat: HistoryChat,
  rows: Row[],
  position: Position,
  count: number,
  budget: number,
): Window {
  let index = positionIndex(rows, position);
  let offset = position.offset;
  let boundary = position;
  const messages: HistoryReadMessage[] = [];

  while (
    index >= 0 &&
    index < rows.length &&
    messages.length < count &&
    budget > 0
  ) {
    const row = rows[index]!;
    const points = Array.from(row.body ?? "");

    if (offset > 0) {
      const start = Math.max(0, offset - budget);

      messages.unshift(messagePart(chat, row, points, start, offset));
      budget -= offset - start;
      boundary = { messageId: row.original.id, offset: start };

      if (start > 0) break;
    }

    index -= 1;
    offset = index >= 0 ? Array.from(rows[index]!.body ?? "").length : 0;
  }

  return { messages, start: boundary, finish: position };
}

function windowFrom(
  chat: HistoryChat,
  rows: Row[],
  position: Position,
  direction: Direction,
  count: number,
  budget: number,
): Window {
  return direction === "after"
    ? windowAfter(chat, rows, position, count, budget)
    : windowBefore(chat, rows, position, count, budget);
}

function readWindow(
  chat: HistoryChat,
  rows: Row[],
  token: ReadToken,
  direction: Direction | undefined,
): Window {
  return windowFrom(
    chat,
    rows,
    token.position,
    direction ?? token.direction,
    30,
    20000,
  );
}

function aroundWindow(
  chat: HistoryChat,
  rows: Row[],
  position: Position,
): Window {
  const older = windowFrom(chat, rows, position, "before", 14, 10000);

  const used = older.messages.reduce(
    (sum, message) => sum + Array.from(message.text).length,
    0,
  );

  const newer = windowFrom(
    chat,
    rows,
    position,
    "after",
    30 - older.messages.length,
    20000 - used,
  );

  return {
    messages: [...older.messages, ...newer.messages],
    start: older.start,
    finish: newer.finish,
  };
}

function matchWindow(
  chat: HistoryChat,
  rows: Row[],
  messageId: string,
  direction: Direction | undefined,
): Window {
  const anchor = rows.find((row) => row.original.id === messageId);

  if (!anchor)
    throw new Error(
      "History message is no longer available; start a new search",
    );

  const position: Position = { messageId, offset: 0 };

  if (direction === undefined) return aroundWindow(chat, rows, position);

  if (direction === "after")
    position.offset = Array.from(anchor.body ?? "").length;

  return windowFrom(chat, rows, position, direction, 30, 20000);
}

function atBeginning(index: number, position: Position): boolean {
  return index === 0 && position.offset === 0;
}

function atEnd(rows: Row[], index: number, position: Position): boolean {
  return (
    index === rows.length - 1 &&
    position.offset === Array.from(rows[index]!.body ?? "").length
  );
}

function withinWindow(
  row: Row,
  first: Row,
  final: Row,
  beginning: boolean,
  end: boolean,
): boolean {
  const afterStart =
    beginning ||
    row.entry > first.entry ||
    (row.entry === first.entry && row.index >= first.index);

  const beforeEnd =
    end ||
    row.entry < final.entry ||
    (row.entry === final.entry && row.index <= final.index);

  return afterStart && beforeEnd;
}

function omitsToolActivity(
  chat: HistoryChat,
  rows: Row[],
  first: Row,
  final: Row,
  beginning: boolean,
  end: boolean,
): boolean {
  return (
    chat.kind === "bot" &&
    rows.some(
      (row) =>
        row.toolActivity && withinWindow(row, first, final, beginning, end),
    )
  );
}

export class HistorySearch {
  private readonly key = randomBytes(32);

  constructor(private readonly source: HistorySource) {}

  private token(payload: Token): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);

    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);

    return `hs1.${Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
  }

  private open(context: HistoryContext, token: string): Token {
    try {
      if (!/^hs1\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
      const bytes = Buffer.from(token.slice(4), "base64url");

      if (bytes.length < 29) throw new Error();

      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );

      decipher.setAuthTag(bytes.subarray(12, 28));

      const plaintext = Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString("utf8");

      const payload = tokenSchema.parse(JSON.parse(plaintext));

      if (
        payload.agentId !== context.agentId ||
        payload.groupId !== context.groupId
      )
        throw new Error();

      return payload;
    } catch {
      throw new Error("Invalid or expired history token; start a new search");
    }
  }

  private async chats(context: HistoryContext): Promise<HistoryChat[]> {
    const available = await this.source.chats(context);
    const seen = new Set<string>();

    return available.filter((chat) => {
      if (seen.has(chat.id))
        throw new Error("History source returned duplicate chats");
      seen.add(chat.id);

      return context.groupId !== null
        ? chat.kind === "group" && chat.id === context.groupId
        : chat.kind === "group" || chat.id === context.agentId;
    });
  }

  private async scan(
    context: HistoryContext,
    chat: HistoryChat,
    cutoff: number,
  ): Promise<{ snapshot: Snapshot; rows: Row[] }> {
    const rows: Row[] = [];
    const seen = new Set<string>();

    if (cutoff === 0) return { snapshot: { chat, cutoff }, rows };

    let before =
      cutoff < Number.MAX_SAFE_INTEGER ? `${chat.id}:${cutoff + 1}` : undefined;

    for (;;) {
      const page = await this.source.page(context, chat, before);
      const oldest = pageCursor(chat, page);

      addPageRows(chat, page, cutoff, seen, rows);

      if (!page.hasMore) break;

      before = nextCursor(chat, before, oldest, page.oldestEntryId);
    }

    rows.sort((a, b) => a.entry - b.entry || a.index - b.index);

    return { snapshot: { chat, cutoff }, rows };
  }

  private async searchScope(
    context: HistoryContext,
    args: { query?: string; chatId?: string; cursor?: string },
    available: HistoryChat[],
  ): Promise<{
    query: string;
    snapshots: Snapshot[];
    last: MatchKey | undefined;
  }> {
    return args.cursor !== undefined
      ? this.cursorScope(context, args.cursor, args)
      : this.freshScope(context, args, available);
  }

  private cursorScope(
    context: HistoryContext,
    cursor: string,
    args: { query?: string; chatId?: string },
  ) {
    if (args.query !== undefined || args.chatId !== undefined)
      throw new Error("Use only cursor when continuing a history search");

    const token = this.open(context, cursor);

    if (token.type !== "search")
      throw new Error("Expected a history search cursor");

    return { query: token.query, snapshots: token.snapshots, last: token.last };
  }

  private async freshScope(
    context: HistoryContext,
    args: { query?: string; chatId?: string },
    available: HistoryChat[],
  ): Promise<{
    query: string;
    snapshots: Snapshot[];
    last: MatchKey | undefined;
  }> {
    const query = validQuery(args.query);

    const chats = available.filter(
      (chat) => args.chatId === undefined || chat.id === args.chatId,
    );

    if (args.chatId !== undefined && chats.length === 0)
      throw new Error("History chat is unavailable or access is denied");

    return {
      query,
      snapshots: await this.freshSnapshots(context, chats),
      last: undefined,
    };
  }

  private async freshSnapshots(
    context: HistoryContext,
    chats: HistoryChat[],
  ): Promise<Snapshot[]> {
    return Promise.all(
      chats.map(async (chat) => ({
        chat,
        cutoff: pageCutoff(chat, await this.source.page(context, chat)),
      })),
    );
  }

  private async collectCandidates(
    context: HistoryContext,
    available: HistoryChat[],
    snapshots: Snapshot[],
    query: string,
    last: MatchKey | undefined,
  ): Promise<{ candidates: Candidate[]; frozen: Snapshot[] }> {
    const candidates: Candidate[] = [];
    const frozen: Snapshot[] = [];

    for (const snapshot of snapshots) {
      if (!isAvailable(available, snapshot.chat)) {
        frozen.push(snapshot);
        continue;
      }

      const scanned = await this.scan(context, snapshot.chat, snapshot.cutoff);

      frozen.push(scanned.snapshot);

      // One push per match: a whole transcript's matches can exceed the engine's argument limit.
      for (const candidate of matchesIn(
        scanned.snapshot,
        scanned.rows,
        query,
        last,
      ))
        candidates.push(candidate);
    }

    return { candidates, frozen };
  }

  private matchOf(
    context: HistoryContext,
    { snapshot, row }: Candidate,
    query: string,
  ): HistorySearchMatch {
    return {
      match: this.token({
        ...context,
        type: "match",
        snapshot,
        messageId: row.original.id,
      }),
      chat: snapshot.chat,
      messageId: row.original.id,
      entryId: row.original.entryId,
      sender: sender(snapshot.chat, row.original),
      timestamp: timestamp(row.original),
      ...excerpt(row.body ?? "", query),
    };
  }

  private readToken(
    context: HistoryContext,
    args: { match?: string; cursor?: string; direction?: Direction },
  ): MatchToken | ReadToken {
    const request = readRequest(args);

    return narrowToken(this.open(context, request.token), request);
  }

  async search(
    context: HistoryContext,
    args: { query?: string; chatId?: string; cursor?: string },
  ): Promise<HistorySearchResult> {
    const available = await this.chats(context);

    const { query, snapshots, last } = await this.searchScope(
      context,
      args,
      available,
    );

    const { candidates, frozen } = await this.collectCandidates(
      context,
      available,
      snapshots,
      query,
      last,
    );

    candidates.sort((a, b) => compareKeys(a.key, b.key));
    const selected = candidates.slice(0, 20);
    const tail = selected.at(-1);

    return {
      matches: selected.map((candidate) =>
        this.matchOf(context, candidate, query),
      ),
      cursor:
        candidates.length > 20 && tail
          ? this.token({
              ...context,
              type: "search",
              query,
              snapshots: frozen,
              last: tail.key,
            })
          : null,
    };
  }

  async read(
    context: HistoryContext,
    args: { match?: string; cursor?: string; direction?: Direction },
  ): Promise<HistoryReadResult> {
    const token = this.readToken(context, args);
    const { snapshot } = token;
    const available = await this.chats(context);

    if (!isAvailable(available, snapshot.chat))
      throw new Error("History chat is unavailable or access is denied");

    const scanned = await this.scan(context, snapshot.chat, snapshot.cutoff);

    const rows = scanned.rows.filter(
      (row) => row.body !== null && row.body.length > 0,
    );

    const window =
      token.type === "read"
        ? readWindow(snapshot.chat, rows, token, args.direction)
        : matchWindow(snapshot.chat, rows, token.messageId, args.direction);

    const startIndex = positionIndex(rows, window.start);
    const finishIndex = positionIndex(rows, window.finish);
    const beginning = atBeginning(startIndex, window.start);
    const end = atEnd(rows, finishIndex, window.finish);

    return {
      chat: snapshot.chat,
      messages: window.messages,
      before: beginning
        ? null
        : this.token({
            ...context,
            type: "read",
            snapshot,
            position: window.start,
            direction: "before",
          }),
      after: end
        ? null
        : this.token({
            ...context,
            type: "read",
            snapshot,
            position: window.finish,
            direction: "after",
          }),
      beginning,
      end,
      omittedToolActivity: omitsToolActivity(
        snapshot.chat,
        scanned.rows,
        rows[startIndex]!,
        rows[finishIndex]!,
        beginning,
        end,
      ),
    };
  }
}
