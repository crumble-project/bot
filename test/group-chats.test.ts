import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupChats } from "../src/group-chats";
import { GroupTranscripts } from "../src/group-transcripts";
import { Store } from "../src/store";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const agent = (name: string) => ({
  name,
  avatar: "bot",
  description: "",
  instructions: "Answer",
  provider: "openai",
  model: "gpt-4.1",
  enabled: true,
  tools: [],
  skills: [],
  mcpServers: [],
  delegates: [],
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bot-group-chats-"));
  dirs.push(dir);
  const store = new Store(dir);

  const groups = new GroupChats(
    store,
    new GroupTranscripts(join(dir, "groups")),
  );

  const a = store.createAgent(agent("Planner"));
  const b = store.createAgent(agent("Researcher"));

  return {
    groups,
    a,
    b,
    close: async () => {
      await groups.close();
      store.close();
    },
  };
}

describe("GroupChats", () => {
  test("rejects members that are not bots", async () => {
    const { groups, a, close } = setup();

    try {
      expect(() =>
        groups.create({
          name: "Trip",
          memberIds: [a.id, crypto.randomUUID()],
        }),
      ).toThrow("Choose existing bots as members");
    } finally {
      await close();
    }
  });

  test("posts owner messages, notifies subscribers, and serves snapshots", async () => {
    const { groups, a, b, close } = setup();

    try {
      const group = groups.create({ name: "Trip", memberIds: [a.id, b.id] });
      let calls = 0;
      const unsubscribe = groups.subscribe(group.id, () => calls++);
      const receipt = await groups.post(group.id, "Plan it", "r-1");

      expect(receipt.requestId).toBe("r-1");
      expect(receipt.entryId.startsWith(`${group.id}:`)).toBe(true);
      expect(calls).toBe(1);

      const snapshot = await groups.snapshot(group.id, {});

      expect(snapshot.groupChat).toEqual(group);
      expect(snapshot.hasMore).toBe(false);
      expect(snapshot.messages.map((message) => message.content)).toEqual([
        "Plan it",
      ]);

      unsubscribe();
      await groups.post(group.id, "Again", "r-2");
      expect(calls).toBe(1);
    } finally {
      await close();
    }
  });

  test("renames, notifies, and deletes a group with its transcript", async () => {
    const { groups, a, b, close } = setup();

    try {
      const group = groups.create({ name: "Trip", memberIds: [a.id, b.id] });
      let calls = 0;
      groups.subscribe(group.id, () => calls++);

      expect(
        groups.update(group.id, { name: "Holiday", memberIds: [b.id, a.id] }),
      ).toMatchObject({ name: "Holiday", memberIds: [a.id, b.id] });
      expect(calls).toBe(1);

      await groups.post(group.id, "Hello", "r-1");
      await groups.delete(group.id);
      expect(calls).toBe(3);
      expect(() => groups.get(group.id)).toThrow("Group chat not found");
      await expect(groups.post(group.id, "Late", "r-2")).rejects.toThrow(
        "Group chat not found",
      );
    } finally {
      await close();
    }
  });
});
