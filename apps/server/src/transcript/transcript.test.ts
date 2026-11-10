import { describe, expect, test } from "bun:test";
import { latestMessagePreview, readTranscript } from "./transcript";
import type { Cursor, Harness } from "@earendil-works/pi-durable";

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
  data?:
    | { content?: string; communication?: FakeCommunication }
    | Record<string, string | number>;
};

type FakeQuery = {
  maxEntryId?: number;
  minEntryId?: number;
  order?: "ascending" | "descending";
};

function fakeHarness(entries: FakeEntry[]): Harness {
  // SAFETY: The fake harness only implements the root conversation's reads, which transcript helpers use.
  return Object.assign({} as Harness, {
    root: async () => ({
      entries: async (query: FakeQuery, limit: number, cursor?: Cursor) => {
        const all = entries.filter(
          (e) => query.maxEntryId === undefined || e.id <= query.maxEntryId,
        );

        const start = cursor ? Number(cursor["offset"]) : 0;
        const items = all.slice(start, start + limit);

        return {
          items,
          next:
            start + limit < all.length ? { offset: start + limit } : undefined,
        };
      },
    }),
  });
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
    const harness = fakeHarness([
      user(3, "three"),
      { id: 2, conversationId: 1, kind: "pi.reset", model: [] },
      user(1, "one"),
    ]);

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
          status: "sent" as const,
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
      fakeHarness([event, malformed, modelLess]),
      "source",
    );

    expect(result.messages).toEqual([
      {
        id: "source:3:0",
        entryId: "source:3",
        role: "event",
        kind: "bot-message",
        content: "How do you feel?",
        communication: event.data.communication,
      },
    ]);
  });

  test("normalizes call markers: a bot's greeting, Call started, and how a call ended", async () => {
    const call = (id: number, data: Record<string, string | number>) => ({
      id,
      conversationId: 1,
      kind: "crumble.voice-call",
      data: { callId: `c${id}`, timestamp: 5, ...data },
    });

    const result = await readTranscript(
      fakeHarness([
        call(4, {
          phase: "ended",
          direction: "inbound",
          text: "Call ended after 2 minutes.",
        }),
        call(3, { phase: "started", direction: "inbound" }),
        call(2, {
          phase: "started",
          direction: "outbound",
          greeting: "Dinner is ready.",
        }),
        call(1, { phase: "paused", direction: "inbound" }),
      ]),
      "a",
    );

    expect(
      result.messages.map(({ kind, content, call }) => ({
        kind,
        content,
        call,
      })),
    ).toEqual([
      {
        kind: "call-started",
        content: "Dinner is ready.",
        call: { callId: "c2", direction: "outbound" },
      },
      {
        kind: "call-started",
        content: "Call started",
        call: { callId: "c3", direction: "inbound" },
      },
      {
        kind: "call-ended",
        content: "Call ended after 2 minutes.",
        call: { callId: "c4", direction: "inbound" },
      },
    ]);
    expect(result.messages.every((message) => message.role === "event")).toBe(
      true,
    );
  });
});
