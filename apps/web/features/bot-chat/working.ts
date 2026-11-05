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

function toolWork(names: string[]): Working {
  if (names.some((name) => SEARCHING.has(name))) return "searching";

  return names.includes(MEMORY_TOOL_NAME) ? "remembering" : "tinkering";
}

function turnWork(chat: ChatSnapshot): Working {
  if (chat.partial.trim()) return "writing";

  const last = chat.messages.at(-1);

  if (last?.role === "toolResult" && last.isError) return "struggling";

  const calls = last?.role === "assistant" ? toolCalls(last) : [];

  return calls.length
    ? toolWork(calls.map((call) => call.name ?? ""))
    : "thinking";
}

export function workingOf(chat: ChatSnapshot | undefined): Working {
  if (chat?.status === "failed") return "failed";

  return chat?.status === "running" ? turnWork(chat) : "idle";
}

export function useWorking(id: string) {
  return useSyncExternalStore(
    (listener) => queryClient.getQueryCache().subscribe(listener),
    () => workingOf(queryClient.getQueryData(chatQuery(id).queryKey)),
  );
}

export const isBusy = (working: Working) =>
  working !== "idle" && working !== "failed";

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

export function botStatusLine(
  bot: Pick<Bot, "enabled">,
  working: boolean,
  idle: string,
) {
  if (working) return "Working…";

  return bot.enabled ? idle : "Paused";
}
