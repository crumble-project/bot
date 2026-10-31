import { useEffect, useSyncExternalStore } from "react";
import { play } from "cuelume";
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
const SOUND_KEY = "crumble.notification-sound";
const SEEN_KEY = "crumble.notified";

export const notifications = {
  enabled: () => localStorage.getItem(NOTIFY_KEY) !== "off",
  sound: () => localStorage.getItem(SOUND_KEY) !== "off",
  setSound(on: boolean) {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  },
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

type ReplyEvent = Extract<ActivityEvent, { type: "reply" }>;

function canNotify() {
  return (
    notifications.enabled() &&
    "Notification" in window &&
    Notification.permission === "granted"
  );
}

const chatPath = (event: ReplyEvent) =>
  event.groupId ? `/groups/${event.groupId}` : `/bots/${event.agentId}`;

const isShowing = (path: string) =>
  document.visibilityState === "visible" && location.pathname.endsWith(path);

// Replies the owner hasn't seen, by the path of their chat; the tab title counts them.
const unread = new Map<string, number>();
let unreadTotal = 0;
const unreadListeners = new Set<() => void>();

function showUnread() {
  unreadTotal = [...unread.values()].reduce((sum, count) => sum + count, 0);

  for (const listener of unreadListeners) listener();
}

/** How many replies arrived for chats the owner wasn't looking at. */
export function useUnreadCount() {
  return useSyncExternalStore(
    (listener) => {
      unreadListeners.add(listener);

      return () => unreadListeners.delete(listener);
    },
    () => unreadTotal,
  );
}

/** Clears the unread count of the chat on screen; call when the route or the tab's visibility changes. */
export function markSeen() {
  for (const path of unread.keys()) if (isShowing(path)) unread.delete(path);

  showUnread();
}

document.addEventListener("visibilitychange", markSeen);

function noticeTitle(event: ReplyEvent) {
  if (event.groupId)
    return `${event.agentName} in ${event.groupName ?? "a group"}`;

  const job =
    event.origin === "coding" || event.origin === "desktop"
      ? ` · ${event.origin} job ${event.jobName ?? ""}`.trimEnd()
      : "";

  return `${event.agentName}${job}`;
}

/** What a notification is about: a reply, or a bot waiting for an approval or for a credential or login. */
export type NoticeKind = "reply" | "approval" | "credential";

function noticeKind({ waitingFor }: ReplyEvent): NoticeKind {
  if (!waitingFor) return "reply";

  return waitingFor === "credential" || waitingFor === "login"
    ? "credential"
    : "approval";
}

/** Plays a notification's sound; each kind sounds different, so the owner hears what is asked before looking. */
export function playNotice(kind: NoticeKind) {
  if (kind === "approval") play("attention");
  else if (kind === "credential") play("attention", { theme: "mech" });
  else play("ready");
}

function notify(event: ReplyEvent, open: Open) {
  const path = chatPath(event);

  if (event.origin === "bot" || isShowing(path)) return;

  unread.set(path, (unread.get(path) ?? 0) + 1);
  showUnread();

  if (!canNotify() || !firstNotice(event.eventId)) return;

  const kind = noticeKind(event);

  if (notifications.sound()) playNotice(kind);

  const notification = new Notification(noticeTitle(event), {
    body: plain(event.preview) || "Replied",
    icon: "/ui/icon-192.png",
    requireInteraction: kind !== "reply",
    silent: notifications.sound(),
    tag: event.groupId
      ? `reply-group-${event.groupId}`
      : `reply-${event.agentId}`,
  });

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
let activityController: AbortController | null = null;

/** Abort every account-bound stream before replacing the authenticated session. */
export function clearLiveStreams() {
  activityFollower++;
  activityController?.abort();
  activityController = null;

  for (const stream of chatStreams.values()) stream.controller.abort();
  chatStreams.clear();
  unread.clear();
  showUnread();
}

/** Follows the server's activity stream: sidebar previews, notifications, and connection status. */
export function followActivity(open: Open, signal: AbortSignal) {
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
        else notify(event, open);
      },
    },
    controller.signal,
  ).finally(() => {
    if (current === activityFollower) activityController = null;
    report("disconnected");
  });
}
