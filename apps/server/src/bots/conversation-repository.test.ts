import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentInput } from "../shared/domain";
import { Store } from "../../test/support/store";
import {
  ConversationRepository,
  type ConversationPatch,
} from "./conversation-repository";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const make = () => {
  const dir = mkdtempSync(join(tmpdir(), "crumble-conversations-"));
  dirs.push(dir);

  return dir;
};

describe("ConversationRepository", () => {
  test("update keeps the fields a patch leaves out", () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput.parse({ name: "Ada" }));

    const conversation = store.createConversation({
      agentId: agent.id,
      title: "First",
    });

    const update = (patch: ConversationPatch) =>
      store.run(
        ConversationRepository.use((repository) =>
          repository.update(conversation.id, patch),
        ),
      );

    const renamed = update({ title: "Second" });
    expect(renamed?.title).toBe("Second");
    expect(renamed?.archived).toBe(false);
    expect(renamed?.createdAt).toBe(conversation.createdAt);
    expect(renamed?.agentId).toBe(agent.id);
    expect(store.getConversation(conversation.id)?.title).toBe("Second");

    const archived = update({ archived: true });
    expect(archived?.archived).toBe(true);
    expect(archived?.title).toBe("Second");
    store.close();
  });

  test("update returns null for a conversation that does not exist", () => {
    const store = new Store(make());

    const missing = store.run(
      ConversationRepository.use((repository) =>
        repository.update("missing", { title: "Second" }),
      ),
    );

    expect(missing).toBeNull();
    store.close();
  });
});
