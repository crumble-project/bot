import { useEffect, useSyncExternalStore } from "react";
import {
  type ActivityEvent,
  type Bot,
  botsQuery,
  chatQuery,
  followChat,
  follow,
  groupsQuery,
  queryClient,
} from "./api";

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

const chatStreams = new Map<
  string,
  { users: number; controller: AbortController }
>();

const running = (id: string) =>
  queryClient.getQueryData(chatQuery(id).queryKey)?.status === "running";

function release(id: string) {
  const stream = chatStreams.get(id);

  if (stream && stream.users === 0 && !running(id)) {
    stream.controller.abort();
    chatStreams.delete(id);
  }
}

// A bot left while it works stays followed until it finishes, so the sidebar shows it working.
queryClient.getQueryCache().subscribe((event) => {
  const [kind, id] = event.query.queryKey;

  if (kind === "chat" && event.type === "updated") release(String(id));
});

/** Follows a bot's chat while mounted, and afterwards for as long as the bot keeps working. */
export function useChatStream(id: string) {
  useEffect(() => {
    let stream = chatStreams.get(id);

    if (!stream) {
      stream = { users: 0, controller: new AbortController() };
      chatStreams.set(id, stream);
      void followChat(id, stream.controller.signal);
    }

    stream.users++;

    return () => {
      stream.users--;
      release(id);
    };
  }, [id]);
}

/** Whether a bot is answering, from its cached chat; never fetches. */
export function useWorking(id: string) {
  return useSyncExternalStore(
    (listener) => queryClient.getQueryCache().subscribe(listener),
    () => running(id),
  );
}

const NOTIFY_KEY = "crumble.notifications";
const SEEN_KEY = "crumble.notified";

export const notifications = {
  enabled: () => localStorage.getItem(NOTIFY_KEY) !== "off",
  async setEnabled(on: boolean) {
    localStorage.setItem(NOTIFY_KEY, on ? "on" : "off");

    if (on && "Notification" in window && Notification.permission === "default")
      await Notification.requestPermission();
  },
  permission: (): NotificationPermission | "unsupported" =>
    "Notification" in window ? Notification.permission : "unsupported",
};

function firstNotice(key: string) {
  const seen: string[] = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");

  if (seen.includes(key)) return false;
  localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, key].slice(-512)));

  return true;
}

function plain(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type Open = (target: { botId?: string; groupId?: string }) => void;

function notify(event: Extract<ActivityEvent, { type: "reply" }>, open: Open) {
  if (event.origin === "bot" || !notifications.enabled()) return;

  if (!("Notification" in window) || Notification.permission !== "granted")
    return;

  const path = location.pathname;

  const showing = event.groupId
    ? path.endsWith(`/groups/${event.groupId}`)
    : path.endsWith(`/bots/${event.agentId}`);

  if (document.visibilityState === "visible" && showing) return;

  if (!firstNotice(event.eventId)) return;

  const job =
    event.origin === "coding" || event.origin === "desktop"
      ? ` · ${event.origin} job ${event.jobName ?? ""}`.trimEnd()
      : "";

  const notification = new Notification(
    event.groupId
      ? `${event.agentName} in ${event.groupName ?? "a group"}`
      : `${event.agentName}${job}`,
    {
      body: plain(event.preview) || "Replied",
      tag: event.groupId
        ? `reply-group-${event.groupId}`
        : `reply-${event.agentId}`,
    },
  );

  notification.onclick = () => {
    window.focus();
    open(event.groupId ? { groupId: event.groupId } : { botId: event.agentId });
    notification.close();
  };
}

function preview(agentId: string, lastMessage: string) {
  queryClient.setQueryData(botsQuery.queryKey, (bots: Bot[] | undefined) =>
    bots?.map((bot) => (bot.id === agentId ? { ...bot, lastMessage } : bot)),
  );
}

let activityFollower = 0;

/** Follows the server's activity stream: sidebar previews, notifications, and connection status. */
export function followActivity(open: Open, signal: AbortSignal) {
  let connections = 0;
  const current = ++activityFollower;

  // A stopped follower may settle after its replacement connected; only the latest reports.
  const report = (next: Status) => {
    if (current === activityFollower) setStatus(next);
  };

  void follow(
    "/v1/events",
    {
      onStatus: report,
      onOpen: () => {
        // Bots and groups may have changed while the stream was down.
        if (connections++ > 0) {
          void queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });
          void queryClient.invalidateQueries({
            queryKey: groupsQuery.queryKey,
          });
        }
      },
      onEvent: (name, data) => {
        if (name !== "activity") return;

        const event: ActivityEvent = JSON.parse(data);

        if (event.type === "chat-preview")
          preview(event.agentId, event.lastMessage);
        else if (event.type === "reply") notify(event, open);
        // Learned-change notices are shown by the chat view in a later change; nothing to do here yet.
      },
    },
    signal,
  ).finally(() => report("disconnected"));
}
