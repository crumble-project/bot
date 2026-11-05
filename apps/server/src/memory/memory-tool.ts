import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  LiveDoc,
} from "@earendil-works/pi-durable";
import {
  BOT_TOOL,
  MEMORY_TOOL_NAME,
  MEMORY_WRITE_ACTIONS,
} from "../contract/tools";
import { groupOf } from "../group-chats/group-conversation";
import type { Agent } from "../contract/agents";
import { MAX_MEMORY_CHARS } from "../shared/limits";
import { reviewOf } from "../learned-changes/review-conversation";

export type MemoryRecord = {
  id: string;
  content: string;
  shared?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryContext = {
  groupId: string | null;
  submissionIds: string[];
  reviewOf: string | null;
};

export type MemoryStore = {
  listMemory: (agentId: string) => MemoryRecord[] | Promise<MemoryRecord[]>;
  createMemory: (
    agentId: string,
    content: string,
    shared: boolean,
    context: MemoryContext,
  ) => MemoryRecord | Promise<MemoryRecord>;
  updateMemory: (
    agentId: string,
    id: string,
    content: string,
    context: MemoryContext,
  ) => MemoryRecord | Promise<MemoryRecord>;
  deleteMemory: (
    agentId: string,
    id: string,
    context: MemoryContext,
  ) => void | Promise<void>;
};

type MemoryArgs = {
  action: "list" | (typeof MEMORY_WRITE_ACTIONS)[number];
  id?: string | undefined;
  content?: string | undefined;
  shared?: boolean | undefined;
};

function assertMemoryEnabled(agent: Agent | null | undefined) {
  if (!agent?.enabled || !agent.tools.includes(BOT_TOOL.memory))
    throw new Error("Memory access is disabled for this agent");
}

function createMemoryAction(
  store: MemoryStore,
  agentId: string,
  args: MemoryArgs,
  context: MemoryContext,
) {
  if (!args.content?.trim()) throw new Error("Memory content is required");

  return store.createMemory(
    agentId,
    args.content,
    args.shared === true,
    context,
  );
}

function updateMemoryAction(
  store: MemoryStore,
  agentId: string,
  args: MemoryArgs,
  context: MemoryContext,
) {
  if (!args.id || !args.content?.trim())
    throw new Error("Memory ID and content are required");

  return store.updateMemory(agentId, args.id, args.content, context);
}

async function deleteMemoryAction(
  store: MemoryStore,
  agentId: string,
  args: MemoryArgs,
  context: MemoryContext,
) {
  if (!args.id) throw new Error("Memory ID is required");
  await store.deleteMemory(agentId, args.id, context);

  return { deleted: true as const };
}

async function runMemoryAction(
  store: MemoryStore,
  agentId: string,
  args: MemoryArgs,
  context: MemoryContext,
): Promise<MemoryRecord[] | MemoryRecord | { deleted: true }> {
  if (args.action === "list") return store.listMemory(agentId);

  if (args.action === "create")
    return createMemoryAction(store, agentId, args, context);

  if (args.action === "update")
    return updateMemoryAction(store, agentId, args, context);

  return deleteMemoryAction(store, agentId, args, context);
}

export function memoryExtension(
  agent: Agent,
  store: MemoryStore,
  current: (agent: Agent) => Agent | null,
) {
  const tool = defineTool({
    name: MEMORY_TOOL_NAME,
    description:
      "Read and manage this agent’s persistent memory. When the agent uses shared memory, `list` also returns shared memories (marked `shared`), which other agents see too; create one with `shared: true` only for what every agent should know. In a group chat only your own memory can be changed.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        ...MEMORY_WRITE_ACTIONS.map((action) => Type.Literal(action)),
      ]),
      id: Type.Optional(Type.String({ minLength: 1 })),
      content: Type.Optional(
        Type.String({ minLength: 1, maxLength: MAX_MEMORY_CHARS }),
      ),
      shared: Type.Optional(Type.Boolean()),
    }),
    // Writes are not replay-safe: interrupted calls report an interruption instead of duplicating a memory.
    replay: "unsafe",
    execute: async (args, api, callContext) => {
      const live = await api.snapshot(LiveDoc, api.conversationId, callContext);

      const [groupId, review] = await Promise.all([
        groupOf(api, api.conversationId, callContext),
        reviewOf(api, api.conversationId, callContext),
      ]);

      const context: MemoryContext = {
        groupId: groupId ?? review?.groupId ?? null,
        submissionIds: (live?.run?.inputs ?? []).map(String),
        reviewOf: review?.executionId ?? null,
      };

      assertMemoryEnabled(current(agent));

      const result = await runMemoryAction(store, agent.id, args, context);

      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  return {
    tool,
    extension: defineExtension({ name: "memory", tools: [tool] }),
  };
}
