import { Effect } from "effect";
import { groupConversations } from "../../src/group-chats/group-turns";
import { reviewConversations } from "../../src/learning/review-kind";
import { callConversations } from "../../src/voice-gateway/call-conversation";
import { hostModels } from "../../src/providers/providers";
import type { RuntimeCallbacks } from "../../src/bots/runtime";
import type { BotSkills } from "../../src/skills/skills";
import { InvalidInput } from "../../src/shared/errors";

const unsupported = () =>
  Effect.die(new Error("no skill library in this test"));

const noMemoryStore = () => {
  throw new Error("no memory store in this test");
};

const noSkills: BotSkills["Service"] = {
  available: () => Effect.succeed([]),
  used: () => Effect.void,
  own: () => Effect.succeed([]),
  create: unsupported,
  update: unsupported,
  remove: unsupported,
  transaction: (effect) => effect,
};

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
  validateFiles: (_agentId, ids) =>
    ids.length
      ? Effect.fail(new InvalidInput({ message: "File not found" }))
      : Effect.void,
  resolveFiles: (_agentId, ids) =>
    Effect.succeed(ids.map((id) => ({ file: { id, deleted: true as const } }))),
  existingFiles: () => Effect.succeed(new Set()),
  visionModel: () => undefined,
  extensions: () => [],
  jobExtensions: () => [],
  conversationKinds: () => [
    groupConversations(),
    reviewConversations(),
    callConversations(),
  ],
  env: () => undefined,
  ...overrides,
});
