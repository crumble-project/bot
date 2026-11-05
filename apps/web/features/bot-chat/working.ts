import { useSyncExternalStore } from "react";
import {
  HISTORY_READ_TOOL_NAME,
  HISTORY_SEARCH_TOOL_NAME,
  MEMORY_TOOL_NAME,
  WEB_EXTRACT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "@crumble/server/contract/tools";
import { blocksOf } from "@/features/chat/tool-details";
import {
  type ChatSnapshot,
  chatQuery,
  type Message,
} from "@/features/chat/api";
import { queryClient } from "@/lib/api";
import { type Bot } from "@/features/bots/api";

/** What a bot is doing, read from its chat, so its avatar can act it out. */
export type Working =
  | "idle"
  | "thinking"
  | "writing"
  | "searching"
  | "remembering"
  | "tinkering"
  | "struggling"
  | "failed";

const SEARCHING = new Set<string>([
  WEB_SEARCH_TOOL_NAME,
  WEB_EXTRACT_TOOL_NAME,
  HISTORY_SEARCH_TOOL_NAME,
  HISTORY_READ_TOOL_NAME,
]);

const toolCalls = (message: Message) =>
  blocksOf(message).filter((block) => block.type === "toolCall");

/** What a bot does while waiting on these tool calls. */
function toolWork(names: string[]): Working {
  if (names.some((name) => SEARCHING.has(name))) return "searching";

  return names.includes(MEMORY_TOOL_NAME) ? "remembering" : "tinkering";
}

/** A running turn's working: streaming its reply, recovering from a tool error, or waiting on tools. */
function turnWork(chat: ChatSnapshot): Working {
  if (chat.partial.trim()) return "writing";

  const last = chat.messages.at(-1);

  if (last?.role === "toolResult" && last.isError) return "struggling";

  const calls = last?.role === "assistant" ? toolCalls(last) : [];

  return calls.length
    ? toolWork(calls.map((call) => call.name ?? ""))
    : "thinking";
}

/** A chat's working: what its running turn does, or how its last turn ended. */
export function workingOf(chat: ChatSnapshot | undefined): Working {
  if (chat?.status === "failed") return "failed";

  return chat?.status === "running" ? turnWork(chat) : "idle";
}

/** A bot's working from its cached chat; never fetches. */
export function useWorking(id: string) {
  return useSyncExternalStore(
    (listener) => queryClient.getQueryCache().subscribe(listener),
    () => workingOf(queryClient.getQueryData(chatQuery(id).queryKey)),
  );
}

export const isBusy = (working: Working) =>
  working !== "idle" && working !== "failed";

/** What the chat says a busy bot is doing. */
export const workingLabel: Record<Working, string> = {
  idle: "Working",
  thinking: "Thinking",
  writing: "Writing",
  searching: "Searching",
  remembering: "Remembering",
  tinkering: "Using tools",
  struggling: "Retrying",
  failed: "Working",
};

/** The line under a bot's name: working or paused say so, otherwise `idle` shows. */
export function botStatusLine(
  bot: Pick<Bot, "enabled">,
  working: boolean,
  idle: string,
) {
  if (working) return "Working…";

  return bot.enabled ? idle : "Paused";
}
