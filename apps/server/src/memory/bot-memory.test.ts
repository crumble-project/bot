import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Effect } from "effect";
import { agentInput } from "../contract/agents";
import { Store } from "../../test/support/store";
import type { MemoryContext } from "./memory-tool";
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
  submissionIds: [],
  reviewOf: null,
};

const sharing = store.createAgent(
  agentInput.parse({ name: "Ada", tools: ["memory"] }),
);

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

  test("refuses empty memories and permits shared memory changes in the bot chat", async () => {
    await expect(
      run((memory) => memory.create(solo.id, "  ", false, chat)),
    ).rejects.toThrow("Memory must contain");
    const shared = await run((memory) =>
      memory.create(sharing.id, "for all", true, chat),
    );
    expect(
      (
        await run((memory) =>
          memory.update(sharing.id, shared.id, "updated", chat),
        )
      ).content,
    ).toBe("updated");
    await run((memory) => memory.delete(sharing.id, shared.id, chat));
    expect(
      (await run((memory) => memory.list(sharing.id))).some(
        (memory) => memory.id === shared.id,
      ),
    ).toBe(false);
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
