import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Effect } from "effect";
import { agentInput } from "../shared/domain";
import { Store } from "../../test/support/store";
import type { MemoryContext } from "../bots/runtime";
import { BotMemory } from "./bot-memory";

const dir = mkdtempSync(join(tmpdir(), "crumble-bot-memory-"));
const store = new Store(dir);

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = <A>(
  use: (memory: BotMemory["Service"]) => Effect.Effect<A, unknown>,
) => store.runtime.runPromise(BotMemory.use(use));

const chat: MemoryContext = {
  groupId: null,
  submissionIds: [],
  reviewOf: null,
};

const sharing = store.createAgent(
  agentInput.parse({ name: "Ada", tools: ["memory"] }),
);

// Shared memory comes with the memory tool.
const solo = store.createAgent(agentInput.parse({ name: "Grace", tools: [] }));

describe("BotMemory", () => {
  test("a bot that shares memory lists the shared memories too", async () => {
    const own = await run((memory) =>
      memory.create(sharing.id, "own", false, chat),
    );

    const shared = await run((memory) =>
      memory.create(sharing.id, "everyone", true, chat),
    );

    expect(
      (await run((memory) => memory.list(sharing.id))).map((each) => [
        each.id,
        each.shared,
      ]),
    ).toEqual([
      [own.id, undefined],
      [shared.id, true],
    ]);
    expect(await run((memory) => memory.list(solo.id))).toEqual([]);
    expect(store.listChanges(sharing.id)[0]).toMatchObject({
      actor: "bot",
      target: "memory",
      targetId: own.id,
    });
  });

  test("refuses empty memories, shared ones when sharing is off, and shared ones in a group", async () => {
    await expect(
      run((memory) => memory.create(solo.id, "  ", false, chat)),
    ).rejects.toThrow("Memory must contain");
    await expect(
      run((memory) => memory.create(solo.id, "x", true, chat)),
    ).rejects.toThrow("Shared memory is off");
    await expect(
      run((memory) =>
        memory.create(sharing.id, "x", true, { ...chat, groupId: "g" }),
      ),
    ).rejects.toThrow("save to your own memory");
  });

  test("another bot's memory is not found, and a review's change names the review", async () => {
    const saved = await run((memory) =>
      memory.create(sharing.id, "mine", false, chat),
    );

    await expect(
      run((memory) => memory.update(solo.id, saved.id, "taken", chat)),
    ).rejects.toThrow("Memory not found");
    await expect(
      run((memory) => memory.delete(solo.id, saved.id, chat)),
    ).rejects.toThrow("Memory not found");

    const updated = await run((memory) =>
      memory.update(sharing.id, saved.id, "changed", {
        ...chat,
        reviewOf: "execution-1",
      }),
    );

    expect(updated.content).toBe("changed");
    expect(store.listChanges(sharing.id)[0]).toMatchObject({
      actor: "review",
      source: { executionId: "execution-1" },
    });
    await run((memory) => memory.delete(sharing.id, saved.id, chat));
    expect(store.getMemory(saved.id)).toBeNull();
  });
});
