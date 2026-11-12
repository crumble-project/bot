import { useSyncExternalStore } from "react";
import { type ChatSnapshot, chatQuery } from "@/features/chat/api";
import { queryClient } from "@/lib/api";
import { type Bot } from "@/features/bots/api";

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
