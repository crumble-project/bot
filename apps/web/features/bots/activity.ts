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
import { type Bot } from "./api";

/** What a bot is doing, read from its chat, so its avatar can act it out. */
export type Activity =
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
function toolActivity(names: string[]): Activity {
  if (names.some((name) => SEARCHING.has(name))) return "searching";

  return names.includes(MEMORY_TOOL_NAME) ? "remembering" : "tinkering";
}

/** A running turn's activity: streaming its reply, recovering from a tool error, or waiting on tools. */
function turnActivity(chat: ChatSnapshot): Activity {
  if (chat.partial.trim()) return "writing";

  const last = chat.messages.at(-1);

  if (last?.role === "toolResult" && last.isError) return "struggling";

  const calls = last?.role === "assistant" ? toolCalls(last) : [];

  return calls.length
    ? toolActivity(calls.map((call) => call.name ?? ""))
    : "thinking";
}

/** A chat's activity: what its running turn does, or how its last turn ended. */
export function activityOf(chat: ChatSnapshot | undefined): Activity {
  if (chat?.status === "failed") return "failed";

  return chat?.status === "running" ? turnActivity(chat) : "idle";
}

/** A bot's activity from its cached chat; never fetches. */
export function useActivity(id: string) {
  return useSyncExternalStore(
    (listener) => queryClient.getQueryCache().subscribe(listener),
    () => activityOf(queryClient.getQueryData(chatQuery(id).queryKey)),
  );
}

export const isBusy = (activity: Activity) =>
  activity !== "idle" && activity !== "failed";

/** What the chat says a busy bot is doing. */
export const activityLabel: Record<Activity, string> = {
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
