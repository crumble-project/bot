import { useSyncExternalStore } from "react";
import {
  activityEvent,
  botStatusEvent,
  pinsEvent,
} from "@crumble/server/contract/api-responses";
import { authClient } from "@/lib/auth-client";
import { botsQuery, invalidateBots } from "@/features/bots/api";
import type { Bot } from "@/features/bots/api";
import { chatQuery } from "@/features/chat/api";
import { follow, queryClient } from "@/lib/api";
import { notifyReply } from "@/lib/notifications";
import type { ChatLinks } from "@/lib/notifications";
import { onSessionReset } from "@/lib/session";

type Status = "connected" | "reconnecting" | "disconnected";

let status: Status = "disconnected";
const statusListeners = new Set<() => void>();

function setStatus(next: Status) {
  status = next;

  for (const listener of statusListeners) {
    listener();
  }
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
  queryClient.setQueryData(botsQuery.queryKey, (bots: Array<Bot> | undefined) =>
    bots?.map((bot) => (bot.id === agentId ? { ...bot, lastMessage } : bot)),
  );
}

function setStatusOf(agentId: string, botStatus: Bot["status"]) {
  queryClient.setQueryData(botsQuery.queryKey, (bots: Array<Bot> | undefined) =>
    bots?.map((bot) =>
      bot.id === agentId ? { ...bot, status: botStatus } : bot,
    ),
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

  const report = (next: Status) => {
    if (current === activityFollower) {
      setStatus(next);
    }
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
        if (connections++ > 0) {
          void invalidateBots();
          authClient.$store.notify("$sessionSignal");
        }
      },
      onEvent: (name, data) => {
        if (name === "pins") {
          pinsEvent.parse(JSON.parse(data));
          authClient.$store.notify("$sessionSignal");

          return;
        }

        if (name === "bot-status") {
          const event = botStatusEvent.parse(JSON.parse(data));
          setStatusOf(event.agentId, event.status);

          return;
        }

        if (name !== "activity") {
          return;
        }

        const event = activityEvent.parse(JSON.parse(data));

        if (event.type === "chat-preview") {
          preview(event.agentId, event.lastMessage);
        } else {
          const queryKey = chatQuery(event.agentId).queryKey;

          void queryClient.invalidateQueries({ queryKey });
          notifyReply(event, links);
        }
      },
    },
    controller.signal,
  ).finally(() => {
    if (current === activityFollower) {
      activityController = null;
    }
    report("disconnected");
  });
}
