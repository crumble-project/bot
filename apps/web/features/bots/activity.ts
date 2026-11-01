import { useSyncExternalStore } from "react";
import { type ChatSnapshot, chatQuery, queryClient } from "@/lib/api";

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

const SEARCHING = new Set([
  "web_search",
  "web_extract",
  "history_search",
  "history_read",
]);

type Block = { type?: string; name?: string };

function toolCalls(message: ChatSnapshot["messages"][number]) {
  // SAFETY: Provider content blocks are objects with a `type`.
  const blocks = Array.isArray(message.blocks)
    ? (message.blocks as Block[])
    : [];

  return blocks.filter((block) => block.type === "toolCall");
}

/** What a bot does while waiting on these tool calls. */
function toolActivity(names: string[]): Activity {
  if (names.some((name) => SEARCHING.has(name))) return "searching";

  return names.includes("memory") ? "remembering" : "tinkering";
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
