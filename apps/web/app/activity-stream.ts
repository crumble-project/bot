import { useSyncExternalStore } from "react";
import type { ActivityEvent } from "@/features/activity/api";
import { type Bot, botsQuery, invalidateBots } from "@/features/bots/api";
import { invalidateGroups } from "@/features/group-chats/api";
import { follow, queryClient } from "@/lib/api";
import { type ChatLinks, notifyReply } from "@/lib/notifications";
import { onSessionReset } from "@/lib/session";

type Status = "connected" | "reconnecting" | "disconnected";

let status: Status = "disconnected";
const statusListeners = new Set<() => void>();

function setStatus(next: Status) {
  status = next;

  for (const listener of statusListeners) listener();
}

export function useConnectionStatus() {
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener);

      return () => statusListeners.delete(listener);
    },
    () => status,
  );
}

function preview(agentId: string, lastMessage: string) {
  queryClient.setQueryData(botsQuery.queryKey, (bots: Bot[] | undefined) =>
    bots?.map((bot) => (bot.id === agentId ? { ...bot, lastMessage } : bot)),
  );
}

let activityFollower = 0;
let activityController: AbortController | null = null;

onSessionReset(() => {
  activityFollower++;
  activityController?.abort();
  activityController = null;
});

export function followActivity(links: ChatLinks, signal: AbortSignal) {
  let connections = 0;
  const current = ++activityFollower;

  // A stopped follower may settle after its replacement connected; only the latest reports.
  const report = (next: Status) => {
    if (current === activityFollower) setStatus(next);
  };

  const controller = new AbortController();
  activityController = controller;
  signal.addEventListener("abort", () => controller.abort(), {
    once: true,
  });

  void follow(
    "/v1/events",
    {
      onStatus: report,
      onOpen: () => {
        // Bots and groups may have changed while the stream was down.
        if (connections++ > 0) {
          void invalidateBots();
          void invalidateGroups();
        }
      },
      onEvent: (name, data) => {
        if (name !== "activity") return;

        const event: ActivityEvent = JSON.parse(data);

        if (event.type === "chat-preview")
          preview(event.agentId, event.lastMessage);
        else notifyReply(event, links);
      },
    },
    controller.signal,
  ).finally(() => {
    if (current === activityFollower) activityController = null;
    report("disconnected");
  });
}
