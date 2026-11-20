import { useSyncExternalStore } from "react";
import { type ChatSnapshot, chatQuery } from "@/features/chat/api";
import { queryClient } from "@/lib/api";
import { type Bot } from "@/features/bots/api";
import type { BotState } from "@/components/bot-avatar";

export type Working = ChatSnapshot["working"];

export function workingOf(chat: ChatSnapshot | undefined): Working {
  return chat?.working ?? "idle";
}

export function useWorking(id: string) {
  return useSyncExternalStore(
    (listener) => queryClient.getQueryCache().subscribe(listener),
    () => workingOf(queryClient.getQueryData(chatQuery(id).queryKey)),
  );
}

export const isBusy = (working: Working) =>
  working !== "idle" && working !== "failed";

/** Thinking shows the dots, a retry the warning mark; a finished or failed run rests. */
export const workingAvatar: Record<Working, BotState> = {
  idle: "idle",
  thinking: "thinking",
  writing: "working",
  searching: "working",
  remembering: "working",
  tinkering: "working",
  struggling: "blocked",
  failed: "idle",
};

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
