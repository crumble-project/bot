import { useSyncExternalStore } from "react";
import { play } from "cuelume";
import type { ReplyEvent } from "@crumble/server/contract/reply-event";
import { isJobKind } from "@crumble/server/contract/tools";
import { onSessionReset } from "@/lib/session";
import { plainMarkdown } from "@/lib/utils";

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

export type ReplyChat = { kind: "bot" | "group"; id: string };

const chatOf = ({ groupId, agentId }: ReplyEvent): ReplyChat =>
  groupId ? { kind: "group", id: groupId } : { kind: "bot", id: agentId };

const chatTag = ({ kind, id }: ReplyChat) =>
  kind === "group" ? `reply-group-${id}` : `reply-${id}`;

function canNotify() {
  return (
    notifications.enabled() &&
    "Notification" in window &&
    Notification.permission === "granted"
  );
}

const isShowing = (path: string) =>
  document.visibilityState === "visible" && location.pathname.endsWith(path);

const unread = new Map<string, number>();
let unreadTotal = 0;
const unreadListeners = new Set<() => void>();

function showUnread() {
  unreadTotal = [...unread.values()].reduce((sum, count) => sum + count, 0);

  for (const listener of unreadListeners) listener();
}

onSessionReset(() => {
  unread.clear();
  showUnread();
});

export function useUnreadCount() {
  return useSyncExternalStore(
    (listener) => {
      unreadListeners.add(listener);

      return () => unreadListeners.delete(listener);
    },
    () => unreadTotal,
  );
}

export function markSeen() {
  for (const path of unread.keys()) if (isShowing(path)) unread.delete(path);

  showUnread();
}

document.addEventListener("visibilitychange", markSeen);

function noticeTitle(event: ReplyEvent) {
  if (event.groupId)
    return `${event.agentName} in ${event.groupName ?? "a group"}`;

  const job = isJobKind(event.origin)
    ? ` · ${event.origin} job ${event.jobName ?? ""}`.trimEnd()
    : "";

  return `${event.agentName}${job}`;
}

export type NoticeKind = "reply" | "approval" | "credential";

function noticeKind({ waitingFor }: ReplyEvent): NoticeKind {
  if (!waitingFor) return "reply";

  return waitingFor === "credential" || waitingFor === "login"
    ? "credential"
    : "approval";
}

export function playNotice(kind: NoticeKind) {
  if (kind === "approval") play("attention");
  else if (kind === "credential") play("attention", { theme: "mech" });
  else play("ready");
}

export function showNotice(
  kind: NoticeKind,
  title: string,
  options: { body: string; tag?: string },
) {
  if (notifications.sound()) playNotice(kind);

  if (notifications.permission() !== "granted") return null;

  return new Notification(title, {
    ...options,
    icon: "/icon-192.png",
    requireInteraction: kind !== "reply",
    silent: notifications.sound(),
  });
}

export type ChatLinks = {
  open: (chat: ReplyChat) => void;
  pathOf: (chat: ReplyChat) => string;
};

export function notifyReply(event: ReplyEvent, { open, pathOf }: ChatLinks) {
  const chat = chatOf(event);
  const path = pathOf(chat);

  if (event.origin === "bot" || isShowing(path)) return;

  unread.set(path, (unread.get(path) ?? 0) + 1);
  showUnread();

  // Full storage or a browser without `new Notification`, like Android Chrome, must not end the stream.
  try {
    if (!canNotify() || !firstNotice(event.eventId)) return;

    const notification = showNotice(noticeKind(event), noticeTitle(event), {
      body: plainMarkdown(event.preview) || "Replied",
      tag: chatTag(chat),
    });

    if (!notification) return;

    notification.onclick = () => {
      window.focus();
      open(chat);
      notification.close();
    };
  } catch (error) {
    console.warn("Notice not shown", error);
  }
}
