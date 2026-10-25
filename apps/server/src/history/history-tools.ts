import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Agent } from "../shared/domain";
import { GroupChats } from "../group-chats/group-chats";
import { GroupConversation } from "../group-chats/group-turns";
import type {
  HistoryChat,
  HistoryContext,
  HistorySearch,
  HistorySource,
} from "./history-search";
import { AgentRuntime } from "../bots/runtime";
import type { Store } from "../shared/store";

export const HISTORY_TOOLS_EXTENSION = "history-tools";

const textResult = (text: string) => ({
  output: [{ type: "text" as const, text }],
});

/** Model tools for searching and reading history, scoped to the calling conversation. */
export function historyToolsExtension(
  agent: Pick<Agent, "id">,
  history: HistorySearch,
) {
  const search = defineTool({
    name: "history_search",
    description:
      "Search original owner and bot messages in your own bot chat and current group chats. In a group turn, only that group's shared messages are available. Search is literal and case-insensitive; use the returned match token with history_read to read surrounding messages. Pass the cursor to continue a result page.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      chatId: Type.Optional(Type.String({ minLength: 1 })),
      cursor: Type.Optional(Type.String({ minLength: 1 })),
    }),
    callers: ["model"],
    replay: "safe",
    execute: async (args, api, callContext) => {
      const group = await api.snapshot(
        GroupConversation,
        api.conversationId,
        callContext,
      );

      const context: HistoryContext = {
        agentId: agent.id,
        groupId: group?.groupId ?? null,
      };

      return textResult(JSON.stringify(await history.search(context, args)));
    },
  });

  const read = defineTool({
    name: "history_read",
    description:
      "Read original messages around a history_search match, or continue a read with its cursor. Use direction to continue before or after the selected messages. Access is checked again on every request.",
    parameters: Type.Object({
      match: Type.Optional(Type.String({ minLength: 1 })),
      cursor: Type.Optional(Type.String({ minLength: 1 })),
      direction: Type.Optional(
        Type.Union([Type.Literal("before"), Type.Literal("after")]),
      ),
    }),
    callers: ["model"],
    replay: "safe",
    execute: async (args, api, callContext) => {
      const group = await api.snapshot(
        GroupConversation,
        api.conversationId,
        callContext,
      );

      const context: HistoryContext = {
        agentId: agent.id,
        groupId: group?.groupId ?? null,
      };

      return textResult(JSON.stringify(await history.read(context, args)));
    },
  });

  return defineExtension({
    name: HISTORY_TOOLS_EXTENSION,
    tools: [search, read],
  });
}

/** Adapts the existing retained transcript readers to the history engine. */
export function historySource(
  runtime: AgentRuntime,
  store: Store,
  groups: GroupChats,
): HistorySource {
  return {
    async chats(context): Promise<HistoryChat[]> {
      if (context.groupId) {
        const group = (await groups.forMember(context.agentId)).find(
          (candidate) => candidate.id === context.groupId,
        );

        return group ? [{ id: group.id, kind: "group", name: group.name }] : [];
      }

      const agent = store.getAgent(context.agentId);

      const chats: HistoryChat[] = agent
        ? [{ id: agent.id, kind: "bot", name: agent.name }]
        : [];

      chats.push(
        ...(await groups.forMember(context.agentId)).map((group) => ({
          id: group.id,
          kind: "group" as const,
          name: group.name,
        })),
      );

      return chats;
    },

    async page(context, chat, before) {
      if (chat.kind === "group") {
        if (
          (context.groupId !== null && context.groupId !== chat.id) ||
          !(await groups.forMember(context.agentId)).some(
            (group) => group.id === chat.id,
          )
        )
          throw new Error("Group chat not found");

        return groups.readAsMember(context.agentId, chat.id, { before });
      }

      if (context.groupId !== null || chat.id !== context.agentId)
        throw new Error("Bot chat not found");

      const agent = store.getAgent(context.agentId);

      if (!agent) throw new Error("Bot chat not found");

      return runtime.history(agent, { before, includeActiveAssistant: true });
    },
  };
}
