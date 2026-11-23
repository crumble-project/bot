import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Layer } from "effect";
import type { Agent } from "../contract/agents";
import { AgentRepository } from "../bot-store/agent-repository";
import { BotExtensions, ExtensionPosition } from "../bot-ports/bot-extensions";
import { BotRuntime } from "../bots/runtime";
import type { AgentRuntime } from "../bots/runtime";
import { HistorySearch } from "./history-search";
import type { HistoryContext, HistorySource } from "./history-search";
import {
  HISTORY_READ_TOOL_NAME,
  HISTORY_SEARCH_TOOL_NAME,
} from "../contract/tools";

export const HISTORY_TOOLS_EXTENSION = "history-tools";

const textResult = (text: string) => ({
  output: [{ type: "text" as const, text }],
});

export function historyToolsExtension(
  agent: Pick<Agent, "id">,
  history: HistorySearch,
) {
  const context: HistoryContext = { agentId: agent.id };

  const search = defineTool({
    name: HISTORY_SEARCH_TOOL_NAME,
    description:
      "Search original owner and bot messages in your own bot chat. Search is literal and case-insensitive; use the returned match token with history_read to read surrounding messages. Pass the cursor to continue a result page.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      chatId: Type.Optional(Type.String({ minLength: 1 })),
      cursor: Type.Optional(Type.String({ minLength: 1 })),
    }),
    callers: ["model"],
    replay: "safe",
    execute: async (args) =>
      textResult(JSON.stringify(await history.search(context, args))),
  });

  const read = defineTool({
    name: HISTORY_READ_TOOL_NAME,
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
    execute: async (args) =>
      textResult(JSON.stringify(await history.read(context, args))),
  });

  return defineExtension({
    name: HISTORY_TOOLS_EXTENSION,
    tools: [search, read],
  });
}

export function historySource(
  runtime: AgentRuntime,
  agents: AgentRepository["Service"],
): HistorySource {
  const agentOf = (agentId: string) => Effect.runSync(agents.get(agentId));

  return {
    chats: async (context) => {
      const agent = agentOf(context.agentId);

      return agent ? [{ id: agent.id, kind: "bot", name: agent.name }] : [];
    },

    async page(context, chat, before) {
      if (chat.id !== context.agentId) {
        throw new Error("Bot chat not found");
      }

      const agent = agentOf(context.agentId);

      if (!agent) {
        throw new Error("Bot chat not found");
      }

      return runtime.history(agent, { before, includeActiveAssistant: true });
    },
  };
}

export const historyTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const history = new HistorySearch(
      historySource(yield* BotRuntime, yield* AgentRepository),
    );

    yield* (yield* BotExtensions).register(
      ExtensionPosition.historyTools,
      (agent) => [historyToolsExtension(agent, history)],
    );
  }),
);
