import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupTranscripts } from "./group-transcripts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const make = () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-groups-"));
  dirs.push(dir);

  return dir;
};

const groupId = "00000000-0000-4000-8000-000000000001";
const owner = { kind: "owner" };

describe("GroupTranscripts", () => {
  test("pages messages in order with their sender", async () => {
    const transcripts = new GroupTranscripts(make());

    try {
      const first = await transcripts.post(
        groupId,
        { text: "Plan the trip", sender: owner },
        "r-1",
      );

      await transcripts.post(
        groupId,
        {
          text: "Budget first",
          sender: { kind: "bot", agentId: "a-1", name: "Planner" },
        },
        "r-2",
      );

      const page = await transcripts.history(groupId);

      expect(
        page.messages.map((message) => [
          message.role,
          message.content,
          message.origin?.kind,
          message.requestId,
        ]),
      ).toEqual([
        ["user", "Plan the trip", "owner", "r-1"],
        ["assistant", "Budget first", "bot", "r-2"],
      ]);
      expect(page.messages[1]!.origin).toEqual({
        kind: "bot",
        agentId: "a-1",
        name: "Planner",
      });
      expect(first.startsWith(`${groupId}:`)).toBe(true);
      expect(page.messages[0]!.entryId).toBe(first);
      expect(
        (await transcripts.history(groupId, { before: first })).messages,
      ).toEqual([]);
    } finally {
      await transcripts.close();
    }
  });

  test("writes a retried request once and rejects a different message under its ID", async () => {
    const transcripts = new GroupTranscripts(make());

    try {
      const message = { text: "Hello", sender: owner };
      const first = await transcripts.post(groupId, message, "r-1");

      expect(await transcripts.post(groupId, message, "r-1")).toBe(first);
      expect((await transcripts.history(groupId)).messages).toHaveLength(1);
      await expect(
        transcripts.post(groupId, { text: "Other", sender: owner }, "r-1"),
      ).rejects.toThrow("Request ID already used for a different message");
    } finally {
      await transcripts.close();
    }
  });

  test("keeps messages across reopen and deletes the store", async () => {
    const dir = make();
    const first = new GroupTranscripts(dir);

    await first.post(groupId, { text: "Kept", sender: owner }, "r-1");
    await first.close();

    const second = new GroupTranscripts(dir);

    try {
      expect(
        (await second.history(groupId)).messages.map((m) => m.content),
      ).toEqual(["Kept"]);
      await second.delete(groupId);
      expect(existsSync(join(dir, `${groupId}.sqlite`))).toBe(false);
    } finally {
      await second.close();
    }
  });
});
