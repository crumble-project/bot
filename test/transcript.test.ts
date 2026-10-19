import { describe, expect, test } from "bun:test";
import {
  latestMessagePreview,
  prepareReply,
  readTranscript,
} from "../src/transcript";
import type { Cursor, Harness, Tx } from "@earendil-works/pi-durable";

type FakeCommunication = {
  executionId: string;
  fromAgentId: string;
  fromName: string;
  toAgentId: string;
  toName: string;
  status: string;
};

type FakeEntry = {
  id: number;
  conversationId: number;
  kind: string;
  model?: { role: string; content: string }[];
  data?: { content?: string; communication?: FakeCommunication };
};

type FakeQuery = {
  maxEntryId?: number;
  minEntryId?: number;
  order?: "ascending" | "descending";
};

function fakeHarness(entries: Record<number, FakeEntry[]>): Harness {
  const conversations = Object.keys(entries).map((id) => ({
    id: Number(id),
    conversationId: Number(id),
    kind: "conversation",
  }));

  // SAFETY: The fake harness only implements the transaction methods used by transcript helpers.
  const harness = Object.assign({} as Harness, {
    // SAFETY: The fake harness mirrors the durable transcript transaction shape.
    commit: async <T>(
      fn: (tx: Pick<Tx, "scanConversations">) => T | Promise<T>,
    ) =>
      fn({
        scanConversations: async (
          _q: Parameters<Tx["scanConversations"]>[0],
          _n: number,
          cursor?: Cursor,
        ): Promise<Awaited<ReturnType<Tx["scanConversations"]>>> => {
          const start = cursor ? Number(cursor.offset) : 0;
          const items = conversations.slice(start, start + 1);

          const page = {
            items,
            next:
              start + 1 < conversations.length
                ? { offset: start + 1 }
                : undefined,
          };
          // SAFETY: The fake page contains the conversation records consumed by this test.

          return Object.assign(
            {} as Awaited<ReturnType<Tx["scanConversations"]>>,
            page,
          );
        },
      }),
    conversation: async (id: number) => ({
      entries: async (query: FakeQuery, limit: number, cursor?: Cursor) => {
        const all = (entries[id] ?? []).filter(
          (e) => query.maxEntryId === undefined || e.id <= query.maxEntryId,
        );

        const start = cursor ? Number(cursor.offset) : 0;
        const items = all.slice(start, start + limit);

        return {
          items,
          next:
            start + limit < all.length ? { offset: start + limit } : undefined,
        };
      },
    }),
  });

  return harness;
}

const user = (id: number, text: string, kind = "pi.user") => ({
  id,
  conversationId: 1,
  kind,
  model: [{ role: "user", content: text }],
});

describe("durable transcript helpers", () => {
  test("chooses the latest visible text and skips structural output", () => {
    expect(
      latestMessagePreview([
        {
          id: "1",
          entryId: "a:1",
          role: "assistant",
          content: "Tool call: search",
        },
        {
          id: "2",
          entryId: "a:2",
          role: "assistant",
          content: "Earlier answer",
        },
        { id: "3", entryId: "a:3", role: "assistant", content: "Thinking" },
        {
          id: "4",
          entryId: "a:4",
          role: "user",
          content: "",
          attachments: [
            {
              name: "brief.pdf",
              mimeType: "application/pdf",
              size: 12,
              kind: "text",
            },
          ],
        },
      ]),
    ).toBe("Attachment: brief.pdf");
    expect(
      latestMessagePreview([
        {
          id: "1",
          entryId: "a:1",
          role: "assistant",
          content: "Tool call: search",
        },
        { id: "2", entryId: "a:2", role: "assistant", content: "Answer" },
      ]),
    ).toBe("Answer");
    expect(
      latestMessagePreview([
        { id: "1", entryId: "a:1", role: "user", content: "Build it" },
        {
          id: "2",
          entryId: "a:2",
          role: "toolResult",
          content: "Started demo.",
          toolName: "coding",
          toolDetails: {
            name: "demo",
            status: "working",
            conversationId: "a:3",
          },
        },
      ]),
    ).toBe("Coding job demo");
  });

  test("pages in stable chronological order and keeps structural events", async () => {
    const harness = fakeHarness({
      1: [
        user(3, "three"),
        { id: 2, conversationId: 1, kind: "pi.reset", model: [] },
        user(1, "one"),
      ],
    });

    const first = await readTranscript(harness, "a", { limit: 2 });
    expect(first.messages.map((m) => m.content)).toEqual([
      "Conversation reset",
      "three",
    ]);
    expect(first.hasMore).toBe(true);

    const older = await readTranscript(harness, "a", {
      before: first.oldestEntryId!,
      limit: 2,
    });

    expect(older.messages.map((m) => m.content)).toEqual(["one"]);
  });

  test("limits the newest page and paginates older messages without loss", async () => {
    const harness = fakeHarness({
      1: [user(4, "four"), user(3, "three"), user(2, "two"), user(1, "one")],
    });

    const pages: string[] = [];
    let page = await readTranscript(harness, "a", { limit: 2 });
    pages.push(...page.messages.map((message) => message.content));
    expect(pages).toEqual(["three", "four"]);
    expect(page.hasMore).toBe(true);

    while (page.hasMore) {
      page = await readTranscript(harness, "a", {
        before: page.oldestEntryId!,
        limit: 2,
      });
      pages.unshift(...page.messages.map((message) => message.content));
    }

    expect(pages).toEqual(["one", "two", "three", "four"]);
  });

  test("prepares bounded historical context while preserving the original display text", async () => {
    const long = "x".repeat(9000);

    const harness = fakeHarness({
      1: [user(1, long, "crumble.message"), user(2, "near", "crumble.message")],
    });

    const result = await prepareReply(harness, "a", "a:1", "follow up");
    expect(result.data.text).toBe("follow up");
    expect(result.modelContent).toContain("<reply_context>");
    expect(result.modelContent.length).toBeLessThan(12000 + 100);
    await expect(prepareReply(harness, "b", "a:1", "x")).rejects.toThrow();
  });

  test("normalizes bot communication cards and ignores malformed or model-less entries", async () => {
    const event = {
      id: 3,
      conversationId: 1,
      kind: "crumble.bot-message",
      data: {
        content: "How do you feel?",
        communication: {
          executionId: "execution-1",
          fromAgentId: "source",
          fromName: "Source",
          toAgentId: "target",
          toName: "Bot2",
          status: "sent",
        },
      },
    };

    const malformed = {
      id: 2,
      conversationId: 1,
      kind: "crumble.bot-message",
      data: { content: "missing communication" },
    };

    const modelLess = { id: 1, conversationId: 1, kind: "pi.user" };

    const result = await readTranscript(
      fakeHarness({ 1: [event, malformed, modelLess] }),
      "source",
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      role: "event",
      kind: "bot-message",
      content: "How do you feel?",
      communication: event.data.communication,
    });
  });
});
