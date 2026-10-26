import { expect, test } from "bun:test";
import {
  GROUP_MESSAGE_KIND,
  type TranscriptMessage,
  type TranscriptPage,
} from "../bots/transcript";
import {
  HistorySearch,
  type HistoryChat,
  type HistoryContext,
  type HistorySource,
} from "./history-search";

const context: HistoryContext = { agentId: "bot-a", groupId: null };

type FakeChat = HistoryChat & { messages: TranscriptMessage[] };

function message(
  chatId: string,
  entry: number,
  index: number,
  patch: Partial<TranscriptMessage>,
): TranscriptMessage {
  return {
    id: `${chatId}:${entry}:${index}`,
    entryId: `${chatId}:${entry}`,
    role: "user",
    content: "",
    ...patch,
  };
}

function entryNumberOf(chatId: string, entryId: string): number {
  return Number(entryId.slice(chatId.length + 1));
}

function pageOf(
  chat: FakeChat,
  before: string | undefined,
  pageSize: number,
): TranscriptPage {
  const limit =
    before === undefined
      ? Number.POSITIVE_INFINITY
      : entryNumberOf(chat.id, before);

  const eligible = chat.messages
    .filter((item) => entryNumberOf(chat.id, item.entryId) < limit)
    .sort(
      (a, b) =>
        entryNumberOf(chat.id, b.entryId) - entryNumberOf(chat.id, a.entryId) ||
        b.id.localeCompare(a.id),
    );

  const page = eligible.slice(0, pageSize);

  return {
    messages: page,
    hasMore: page.length < eligible.length,
    oldestEntryId: page.at(-1)?.entryId ?? null,
  };
}

function sourceOf(chats: FakeChat[], pageSize = 100): HistorySource {
  return {
    async chats() {
      return chats.map(({ id, kind, name }) => ({ id, kind, name }));
    },
    async page(_context, chat, before) {
      const source = chats.find(
        (candidate) => candidate.id === chat.id && candidate.kind === chat.kind,
      );

      if (!source) throw new Error("fake chat is missing");

      return pageOf(source, before, pageSize);
    },
  };
}

function ownerMessage(
  chatId: string,
  entry: number,
  text: string,
  timestamp?: number,
): TranscriptMessage {
  const result = message(chatId, entry, 0, {
    kind: "crumble.message",
    content: text,
  });

  if (timestamp !== undefined) result.timestamp = timestamp;

  return result;
}

test("search orders dated matches, then undated matches, then by durable identity", async () => {
  const engine = new HistorySearch(
    sourceOf([
      {
        id: "bot-a",
        kind: "bot",
        name: "Ada",
        messages: [
          ownerMessage("bot-a", 1, "needle one", 100),
          ownerMessage("bot-a", 2, "needle two", 200),
          ownerMessage("bot-a", 3, "needle undated"),
          ownerMessage("bot-a", 4, "unrelated", 150),
          ownerMessage("bot-a", 5, "needle pair first", 400),
          message("bot-a", 5, 1, {
            kind: "crumble.message",
            content: "needle pair second",
            timestamp: 400,
          }),
        ],
      },
    ]),
  );

  const result = await engine.search(context, { query: "Needle" });

  expect(result.matches.map((match) => match.messageId)).toEqual([
    "bot-a:5:1",
    "bot-a:5:0",
    "bot-a:2:0",
    "bot-a:1:0",
    "bot-a:3:0",
  ]);
  expect(result.matches[0]).toMatchObject({
    chat: { id: "bot-a", kind: "bot", name: "Ada" },
    entryId: "bot-a:5",
    sender: { role: "user", name: "Owner" },
    timestamp: 400,
    excerpt: "needle pair second",
    truncated: false,
  });
  expect(result.cursor).toBeNull();
});

test("search reads owner and bot messages in a group and skips other kinds", async () => {
  const engine = new HistorySearch(
    sourceOf([
      {
        id: "group-x",
        kind: "group",
        name: "Team",
        messages: [
          message("group-x", 1, 0, {
            kind: GROUP_MESSAGE_KIND,
            role: "user",
            content: "needle owner",
            origin: { kind: "owner" },
            timestamp: 10,
          }),
          message("group-x", 2, 0, {
            kind: GROUP_MESSAGE_KIND,
            role: "assistant",
            content: "needle bot",
            origin: { kind: "bot", name: "Bea", agentId: "bot-b" },
            timestamp: 20,
          }),
          message("group-x", 3, 0, {
            kind: "crumble.reaction",
            role: "user",
            content: "needle hidden",
            timestamp: 30,
          }),
        ],
      },
    ]),
  );

  const result = await engine.search(
    { agentId: "bot-a", groupId: "group-x" },
    { query: "needle" },
  );

  expect(result.matches.map((match) => match.excerpt)).toEqual([
    "needle bot",
    "needle owner",
  ]);
  expect(result.matches[0]!.sender).toEqual({
    role: "assistant",
    name: "Bea",
    agentId: "bot-b",
    origin: { kind: "bot", name: "Bea", agentId: "bot-b" },
  });
  expect(result.matches[1]!.sender.name).toBe("Owner");
});

test("search continues with a cursor and pages through a long transcript", async () => {
  const messages = Array.from({ length: 25 }, (_, position) =>
    ownerMessage("bot-a", position + 1, `needle ${position + 1}`, position + 1),
  );

  const engine = new HistorySearch(
    sourceOf([{ id: "bot-a", kind: "bot", name: "Ada", messages }], 3),
  );

  const first = await engine.search(context, { query: "needle" });
  expect(first.matches).toHaveLength(20);
  expect(first.cursor).not.toBeNull();

  const second = await engine.search(context, { cursor: first.cursor! });
  expect(second.matches).toHaveLength(5);
  expect(second.cursor).toBeNull();
  expect(second.matches[0]!.excerpt).toBe("needle 5");
});

test("read returns the match in context and reports omitted tool activity", async () => {
  const engine = new HistorySearch(
    sourceOf([
      {
        id: "bot-a",
        kind: "bot",
        name: "Ada",
        messages: [
          message("bot-a", 1, 0, {
            kind: "pi.user",
            content: "needle question",
            blocks: [{ type: "text", text: "needle question" }],
            timestamp: 10,
          }),
          message("bot-a", 2, 0, {
            kind: "pi.assistant",
            role: "assistant",
            content: "",
            blocks: [
              { type: "toolCall", id: "call", name: "probe", arguments: {} },
            ],
            timestamp: 20,
          }),
          message("bot-a", 3, 0, {
            role: "toolResult",
            content: "tool output",
            timestamp: 30,
          }),
          message("bot-a", 4, 0, {
            kind: "pi.assistant",
            role: "assistant",
            content: "answer",
            blocks: [{ type: "text", text: "answer" }],
            timestamp: 40,
          }),
        ],
      },
    ]),
  );

  const found = await engine.search(context, { query: "needle" });
  const result = await engine.read(context, { match: found.matches[0]!.match });

  expect(result.messages.map((item) => item.text)).toEqual([
    "needle question",
    "answer",
  ]);
  expect(result.messages[1]!.sender).toEqual({
    role: "assistant",
    name: "Ada",
    agentId: "bot-a",
  });
  expect(result.beginning).toBe(true);
  expect(result.end).toBe(true);
  expect(result.before).toBeNull();
  expect(result.after).toBeNull();
  expect(result.omittedToolActivity).toBe(true);
});

test("read continues through cursors in both directions", async () => {
  const messages = Array.from({ length: 40 }, (_, position) =>
    ownerMessage(
      "bot-a",
      position + 1,
      position === 0 ? "needle start" : `needle ${position + 1}`,
      position + 1,
    ),
  );

  const engine = new HistorySearch(
    sourceOf([{ id: "bot-a", kind: "bot", name: "Ada", messages }]),
  );

  const found = await engine.search(context, { query: "start" });
  const first = await engine.read(context, { match: found.matches[0]!.match });

  expect(first.messages).toHaveLength(30);
  expect(first.messages[0]!.text).toBe("needle start");
  expect(first.beginning).toBe(true);
  expect(first.end).toBe(false);
  expect(first.before).toBeNull();
  expect(first.after).not.toBeNull();

  const next = await engine.read(context, { cursor: first.after! });

  expect(next.messages[0]!.text).toBe("needle 31");
  expect(next.messages.at(-1)!.text).toBe("needle 40");
  expect(next.end).toBe(true);
  expect(next.after).toBeNull();
  expect(next.before).not.toBeNull();
  expect(next.omittedToolActivity).toBe(false);

  const previous = await engine.read(context, {
    cursor: next.before!,
    direction: "before",
  });

  expect(previous.messages[0]!.text).toBe("needle start");
  expect(previous.messages.at(-1)!.text).toBe("needle 30");
  expect(previous.beginning).toBe(true);
});

test("read truncates a long message and continues after the cut", async () => {
  const engine = new HistorySearch(
    sourceOf([
      {
        id: "bot-a",
        kind: "bot",
        name: "Ada",
        messages: [
          ownerMessage("bot-a", 1, `needle ${"y".repeat(30000)}`, 10),
          ownerMessage("bot-a", 2, "tail", 20),
        ],
      },
    ]),
  );

  const found = await engine.search(context, { query: "needle" });
  expect(found.matches[0]!.truncated).toBe(true);

  const first = await engine.read(context, { match: found.matches[0]!.match });

  expect(first.messages).toHaveLength(1);
  expect(first.messages[0]!.truncated).toBe(true);
  expect(first.messages[0]!.text).toHaveLength(20000);
  expect(first.messages[0]!.totalCodePoints).toBe(30007);
  expect(first.messages[0]!.offset).toBe(0);
  expect(first.end).toBe(false);

  const next = await engine.read(context, { cursor: first.after! });

  expect(next.messages.map((item) => item.text)).toEqual([
    "y".repeat(10007),
    "tail",
  ]);
  expect(next.messages[0]!.offset).toBe(20000);
  expect(next.messages[0]!.truncated).toBe(true);
  expect(next.end).toBe(true);
});

test("read rejects malformed or mismatched requests", async () => {
  const engine = new HistorySearch(
    sourceOf([
      {
        id: "bot-a",
        kind: "bot",
        name: "Ada",
        messages: [ownerMessage("bot-a", 1, "needle", 10)],
      },
    ]),
  );

  const found = await engine.search(context, { query: "needle" });
  const match = found.matches[0]!.match;

  await expect(engine.read(context, {})).rejects.toThrow(
    "Provide exactly one history match or read cursor",
  );
  await expect(engine.read(context, { match, cursor: match })).rejects.toThrow(
    "Provide exactly one history match or read cursor",
  );
  // SAFETY: read validates the direction at run time, which is what this case exercises.
  const sideways = "sideways" as never;

  await expect(
    engine.read(context, { match, direction: sideways }),
  ).rejects.toThrow("Invalid history read direction");
  await expect(engine.read(context, { match: "hs1.nope" })).rejects.toThrow(
    "Invalid or expired history token; start a new search",
  );
  await expect(
    engine.read({ agentId: "bot-b", groupId: null }, { match }),
  ).rejects.toThrow("Invalid or expired history token; start a new search");
  await expect(engine.search(context, { cursor: match })).rejects.toThrow(
    "Expected a history search cursor",
  );
  await expect(
    engine.search(
      { agentId: "bot-b", groupId: null },
      { cursor: found.cursor ?? match },
    ),
  ).rejects.toThrow("Invalid or expired history token; start a new search");
});

test("search rejects malformed requests", async () => {
  const engine = new HistorySearch(
    sourceOf([
      {
        id: "bot-a",
        kind: "bot",
        name: "Ada",
        messages: [ownerMessage("bot-a", 1, "needle", 10)],
      },
    ]),
  );

  await expect(engine.search(context, { query: "   " })).rejects.toThrow(
    "History query must contain non-whitespace text and at most 500 Unicode code points",
  );
  await expect(
    engine.search(context, { query: "x".repeat(501) }),
  ).rejects.toThrow(
    "History query must contain non-whitespace text and at most 500 Unicode code points",
  );
  await expect(
    engine.search(context, { query: "needle", chatId: "bot-z" }),
  ).rejects.toThrow("History chat is unavailable or access is denied");

  const found = await engine.search(context, { query: "needle" });
  await expect(
    engine.search(context, { cursor: found.matches[0]!.match }),
  ).rejects.toThrow("Expected a history search cursor");
});

test("search rejects writes and incomplete cursors from the source", async () => {
  const overlapping: HistorySource = {
    async chats() {
      return [{ id: "bot-a", kind: "bot", name: "Ada" }];
    },
    async page() {
      return {
        messages: [ownerMessage("bot-a", 2, "needle", 10)],
        hasMore: true,
        oldestEntryId: "bot-a:2",
      };
    },
  };

  await expect(
    new HistorySearch(overlapping).search(context, { query: "needle" }),
  ).rejects.toThrow("History source returned overlapping pages");

  let calls = 0;

  const incomplete: HistorySource = {
    async chats() {
      return [{ id: "bot-a", kind: "bot", name: "Ada" }];
    },
    async page() {
      calls += 1;

      return calls === 1
        ? {
            messages: [ownerMessage("bot-a", 2, "needle", 10)],
            hasMore: false,
            oldestEntryId: "bot-a:1",
          }
        : {
            messages: [ownerMessage("bot-a", 1, "needle", 5)],
            hasMore: true,
            oldestEntryId: "bot-a:5",
          };
    },
  };

  await expect(
    new HistorySearch(incomplete).search(context, { query: "needle" }),
  ).rejects.toThrow("History source did not provide a complete page cursor");

  const headless: HistorySource = {
    async chats() {
      return [{ id: "bot-a", kind: "bot", name: "Ada" }];
    },
    async page() {
      return { messages: [], hasMore: true, oldestEntryId: null };
    },
  };

  await expect(
    new HistorySearch(headless).search(context, { query: "needle" }),
  ).rejects.toThrow("History source did not provide a complete page cursor");

  const duplicating: HistorySource = {
    async chats() {
      return [
        { id: "bot-a", kind: "bot", name: "Ada" },
        { id: "bot-a", kind: "bot", name: "Ada" },
      ];
    },
    async page() {
      return { messages: [], hasMore: false, oldestEntryId: null };
    },
  };

  await expect(
    new HistorySearch(duplicating).search(context, { query: "needle" }),
  ).rejects.toThrow("History source returned duplicate chats");
});

test("search rejects invalid identifiers and unavailable chats on read", async () => {
  const badEntry = new HistorySearch(
    sourceOf([
      {
        id: "bot-a",
        kind: "bot",
        name: "Ada",
        messages: [
          {
            id: "bot-a:0:0",
            entryId: "bot-a:0",
            role: "user",
            content: "needle",
          },
        ],
      },
    ]),
  );

  await expect(badEntry.search(context, { query: "needle" })).rejects.toThrow(
    "History source returned an invalid entry identifier",
  );

  const badId = new HistorySearch(
    sourceOf([
      {
        id: "bot-a",
        kind: "bot",
        name: "Ada",
        messages: [
          {
            id: "bot-a:2:0",
            entryId: "bot-a:1",
            role: "user",
            content: "needle",
          },
        ],
      },
    ]),
  );

  await expect(badId.search(context, { query: "needle" })).rejects.toThrow(
    "History source returned an invalid message identifier",
  );

  const messages = [ownerMessage("bot-a", 1, "needle", 10)];

  const engine = new HistorySearch(
    sourceOf([{ id: "bot-a", kind: "bot", name: "Ada", messages }]),
  );

  const found = await engine.search(context, { query: "needle" });

  messages.length = 0;

  await expect(
    engine.read(context, { match: found.matches[0]!.match }),
  ).rejects.toThrow(
    "History message is no longer available; start a new search",
  );

  const groupOnly = new HistorySearch(
    sourceOf([
      {
        id: "group-x",
        kind: "group",
        name: "Team",
        messages: [ownerMessage("group-x", 1, "needle", 10)],
      },
    ]),
  );

  await expect(
    groupOnly.search(context, { query: "needle" }),
  ).resolves.toMatchObject({
    matches: [],
  });
});
