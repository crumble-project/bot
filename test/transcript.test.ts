import { describe, expect, test } from "bun:test";
import { prepareReply, readTranscript } from "../src/transcript";

function fakeHarness(entries: Record<number, any[]>) {
  const conversations = Object.keys(entries).map((id) => ({ id: Number(id) }));
  return {
    commit: async (fn: (tx: any) => unknown) =>
      fn({
        scanConversations: async (_q: unknown, _n: number, cursor?: any) => {
          const start = cursor ? Number(cursor.offset) : 0;
          const items = conversations.slice(start, start + 1);
          return {
            items,
            next:
              start + 1 < conversations.length
                ? { offset: start + 1 }
                : undefined,
          };
        },
      }),
    conversation: async (id: number) => ({
      entries: async (query: any, limit: number, cursor?: any) => {
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
  } as any;
}

const user = (id: number, text: string, kind = "pi.user") => ({
  id,
  conversationId: 1,
  kind,
  model: [{ role: "user", content: text }],
});

describe("durable transcript helpers", () => {
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
});
