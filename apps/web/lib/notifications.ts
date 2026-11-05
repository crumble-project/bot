import { useSyncExternalStore } from "react";
import { play } from "cuelume";
import type { ReplyEvent } from "@crumble/server/contract/reply-event";
import { isJobKind } from "@/lib/job-kinds";
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

/** The chat a reply belongs to. */
export type ReplyChat = { kind: "bot" | "group"; id: string };

const chatOf = ({ groupId, agentId }: ReplyEvent): ReplyChat =>
  groupId ? { kind: "group", id: groupId } : { kind: "bot", id: agentId };

const chatPath = ({ kind, id }: ReplyChat) =>
  kind === "group" ? `/groups/${id}` : `/bots/${id}`;

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

// Replies the owner hasn't seen, by the path of their chat; the tab title counts them.
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

  const job = isJobKind(event.origin)
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

/** Sounds a notice of `kind`, and shows it when the browser allows; the sounds page tests with this too. */
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

/** Counts a reply as unread unless its chat is on screen, and notifies the owner. */
export function notifyReply(
  event: ReplyEvent,
  open: (chat: ReplyChat) => void,
) {
  const chat = chatOf(event);
  const path = chatPath(chat);

  if (event.origin === "bot" || isShowing(path)) return;

  unread.set(path, (unread.get(path) ?? 0) + 1);
  showUnread();

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
}
