import { Effect } from "effect";
import { groupConversations } from "../../src/group-chats/group-turns";
import { reviewConversations } from "../../src/learning/review-conversation";
import { hostModels } from "../../src/providers/providers";
import type { RuntimeCallbacks } from "../../src/bots/runtime";
import type { BotSkills } from "../../src/skills/skills";

const unsupported = () =>
  Effect.die(new Error("no skill library in this test"));

const noMemoryStore = () => {
  throw new Error("no memory store in this test");
};

/** A library with no skills; a test that writes skills supplies a real one. */
const noSkills: BotSkills["Service"] = {
  available: () => Effect.succeed([]),
  used: () => Effect.void,
  own: () => Effect.succeed([]),
  create: unsupported,
  update: unsupported,
  remove: unsupported,
  transaction: (effect) => effect,
};

/** A runtime's callbacks for a test: a bot with no skills, memory, or extensions unless the test gives it some. */
export const runtimeCallbacks = (
  overrides: Partial<RuntimeCallbacks> = {},
): RuntimeCallbacks => ({
  models: hostModels(undefined, []),
  currentAgent: (agent) => agent,
  ownerTimezone: () => undefined,
  listMemory: () => [],
  createMemory: noMemoryStore,
  updateMemory: noMemoryStore,
  deleteMemory: noMemoryStore,
  skillLibrary: noSkills,
  visionModel: () => undefined,
  extensions: () => [],
  jobExtensions: () => [],
  conversationKinds: () => [groupConversations(), reviewConversations()],
  env: () => undefined,
  ...overrides,
});
