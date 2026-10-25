import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  GROUP_MESSAGE_KIND,
  type MessageOrigin,
  type TranscriptMessage,
  type TranscriptPage,
} from "./transcript";

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
  timestamp: z.number().finite().nullable(),
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

function rowOf(chat: HistoryChat, message: TranscriptMessage): Row {
  const entry = entryNumber(chat, message.entryId);
  const prefix = `${message.entryId}:`;
  const suffix = message.id.slice(prefix.length);
  const index = Number(suffix);

  if (
    !message.id.startsWith(prefix) ||
    !/^(0|[1-9][0-9]*)$/.test(suffix) ||
    !Number.isSafeInteger(index)
  )
    throw new Error("History source returned an invalid message identifier");

  const blocks = z.array(z.unknown()).safeParse(message.blocks);

  const toolActivity =
    chat.kind === "bot" &&
    (message.role === "toolResult" ||
      (message.kind === "pi.assistant" &&
        blocks.success &&
        blocks.data.some((block) => toolCallSchema.safeParse(block).success)));

  let body: string | null = null;

  if (chat.kind === "group") {
    if (
      message.kind === GROUP_MESSAGE_KIND &&
      (message.role === "user" || message.role === "assistant") &&
      (message.origin?.kind === "owner" || message.origin?.kind === "bot")
    )
      body = message.content;
  } else if (
    message.kind === "crumble.message" &&
    message.role === "user" &&
    message.origin?.kind !== "bot"
  ) {
    // Reply context lives in blocks; normalize preserves the owner's metadata text in content.
    body = message.content;
  } else if (
    (message.kind === "pi.user" &&
      message.role === "user" &&
      message.origin?.kind !== "bot") ||
    (message.kind === "pi.assistant" && message.role === "assistant")
  ) {
    if (blocks.success) {
      body = blocks.data
        .flatMap((block) => {
          const parsed = textBlockSchema.safeParse(block);

          return parsed.success ? [parsed.data.text] : [];
        })
        .join("\n");
    } else if (message.role === "user") {
      const text = z.string().safeParse(message.blocks);

      if (text.success) body = text.data;
    }
  }

  return { original: message, entry, index, body, toolActivity };
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

function compareKeys(a: MatchKey, b: MatchKey): number {
  // Undated originals remain undated; they sort after dated messages, then by durable identity.
  if (a.timestamp !== b.timestamp) {
    if (a.timestamp === null) return 1;

    if (b.timestamp === null) return -1;

    return b.timestamp - a.timestamp;
  }

  return (
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

function windowFrom(
  chat: HistoryChat,
  rows: Row[],
  position: Position,
  direction: Direction,
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

    if (direction === "after") {
      if (offset < points.length) {
        const finish = Math.min(points.length, offset + budget);
        messages.push(messagePart(chat, row, points, offset, finish));
        budget -= finish - offset;
        boundary = { messageId: row.original.id, offset: finish };

        if (finish < points.length) break;
      }

      index += 1;
      offset = 0;
    } else {
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
  }

  return direction === "after"
    ? { messages, start: position, finish: boundary }
    : { messages, start: boundary, finish: position };
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

    let before =
      cutoff < Number.MAX_SAFE_INTEGER ? `${chat.id}:${cutoff + 1}` : undefined;

    if (cutoff === 0) return { snapshot: { chat, cutoff }, rows };

    for (;;) {
      const page = await this.source.page(context, chat, before);

      const oldest =
        page.oldestEntryId === null
          ? null
          : entryNumber(chat, page.oldestEntryId);

      const pageRows = page.messages.map((message) => rowOf(chat, message));

      for (const row of pageRows) {
        if (row.entry > cutoff) continue;

        if (seen.has(row.original.id))
          throw new Error("History source returned overlapping pages");
        seen.add(row.original.id);
        rows.push(row);
      }

      if (!page.hasMore) break;

      if (
        oldest === null ||
        (before !== undefined && oldest >= entryNumber(chat, before))
      )
        throw new Error(
          "History source did not provide a complete page cursor",
        );
      before = page.oldestEntryId ?? undefined;
    }

    rows.sort((a, b) => a.entry - b.entry || a.index - b.index);

    return { snapshot: { chat, cutoff }, rows };
  }

  async search(
    context: HistoryContext,
    args: { query?: string; chatId?: string; cursor?: string },
  ): Promise<HistorySearchResult> {
    let query: string;
    let snapshots: Snapshot[];
    let last: MatchKey | undefined;
    const available = await this.chats(context);

    if (args.cursor !== undefined) {
      if (args.query !== undefined || args.chatId !== undefined)
        throw new Error("Use only cursor when continuing a history search");
      const token = this.open(context, args.cursor);

      if (token.type !== "search")
        throw new Error("Expected a history search cursor");
      query = token.query;
      snapshots = token.snapshots;
      last = token.last;
    } else {
      if (
        args.query === undefined ||
        !args.query.trim() ||
        Array.from(args.query).length > 500
      )
        throw new Error(
          "History query must contain non-whitespace text and at most 500 Unicode code points",
        );
      query = args.query;

      const chats = available.filter(
        (chat) => args.chatId === undefined || chat.id === args.chatId,
      );

      if (args.chatId !== undefined && chats.length === 0)
        throw new Error("History chat is unavailable or access is denied");
      snapshots = await Promise.all(
        chats.map(async (chat) => {
          const page = await this.source.page(context, chat);

          let cutoff =
            page.oldestEntryId === null
              ? 0
              : entryNumber(chat, page.oldestEntryId);

          for (const message of page.messages)
            cutoff = Math.max(cutoff, entryNumber(chat, message.entryId));

          if (page.hasMore && page.oldestEntryId === null)
            throw new Error(
              "History source did not provide a complete page cursor",
            );

          return { chat, cutoff };
        }),
      );
    }

    const candidates: Candidate[] = [];
    const frozen: Snapshot[] = [];

    for (const snapshot of snapshots) {
      if (
        !available.some(
          (chat) =>
            chat.id === snapshot.chat.id && chat.kind === snapshot.chat.kind,
        )
      ) {
        frozen.push(snapshot);
        continue;
      }

      const scanned = await this.scan(context, snapshot.chat, snapshot.cutoff);

      frozen.push(scanned.snapshot);

      for (const row of scanned.rows) {
        if (!row.body || !row.body.toLowerCase().includes(query.toLowerCase()))
          continue;
        const key = keyOf(snapshot.chat, row);

        if (!last || compareKeys(key, last) > 0)
          candidates.push({ snapshot: scanned.snapshot, row, key });
      }
    }

    candidates.sort((a, b) => compareKeys(a.key, b.key));
    const selected = candidates.slice(0, 20);

    const matches = selected.map(({ snapshot, row }) => ({
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
    }));

    const tail = selected.at(-1);

    return {
      matches,
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
    if ((args.match === undefined) === (args.cursor === undefined))
      throw new Error("Provide exactly one history match or read cursor");

    if (
      args.direction !== undefined &&
      args.direction !== "before" &&
      args.direction !== "after"
    )
      throw new Error("Invalid history read direction");
    const token = this.open(context, args.match ?? args.cursor ?? "");

    if (
      (args.match !== undefined && token.type !== "match") ||
      (args.cursor !== undefined && token.type !== "read") ||
      token.type === "search"
    )
      throw new Error("Expected a history match or read cursor");
    const { snapshot } = token;
    const available = await this.chats(context);

    if (
      !available.some(
        (chat) =>
          chat.id === snapshot.chat.id && chat.kind === snapshot.chat.kind,
      )
    )
      throw new Error("History chat is unavailable or access is denied");
    const scanned = await this.scan(context, snapshot.chat, snapshot.cutoff);

    const rows = scanned.rows.filter(
      (row) => row.body !== null && row.body.length > 0,
    );

    let window: Window;

    if (token.type === "read") {
      window = windowFrom(
        snapshot.chat,
        rows,
        token.position,
        args.direction ?? token.direction,
        30,
        20000,
      );
    } else {
      const anchor = rows.find((row) => row.original.id === token.messageId);

      if (!anchor)
        throw new Error(
          "History message is no longer available; start a new search",
        );
      const position = { messageId: token.messageId, offset: 0 };

      if (args.direction) {
        if (args.direction === "after")
          position.offset = Array.from(anchor.body ?? "").length;
        window = windowFrom(
          snapshot.chat,
          rows,
          position,
          args.direction,
          30,
          20000,
        );
      } else {
        const older = windowFrom(
          snapshot.chat,
          rows,
          position,
          "before",
          14,
          10000,
        );

        const used = older.messages.reduce(
          (sum, message) => sum + Array.from(message.text).length,
          0,
        );

        const newer = windowFrom(
          snapshot.chat,
          rows,
          position,
          "after",
          30 - older.messages.length,
          20000 - used,
        );

        window = {
          messages: [...older.messages, ...newer.messages],
          start: older.start,
          finish: newer.finish,
        };
      }
    }

    const startIndex = positionIndex(rows, window.start);
    const finishIndex = positionIndex(rows, window.finish);
    const beginning = startIndex === 0 && window.start.offset === 0;

    const end =
      finishIndex === rows.length - 1 &&
      window.finish.offset === Array.from(rows[finishIndex]!.body ?? "").length;

    const first = rows[startIndex]!;
    const final = rows[finishIndex]!;

    const omittedToolActivity =
      snapshot.chat.kind === "bot" &&
      scanned.rows.some(
        (row) =>
          row.toolActivity &&
          (beginning ||
            row.entry > first.entry ||
            (row.entry === first.entry && row.index >= first.index)) &&
          (end ||
            row.entry < final.entry ||
            (row.entry === final.entry && row.index <= final.index)),
      );

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
      omittedToolActivity,
    };
  }
}
