import { afterEach, expect, test } from "bun:test";
import type { ReplyEvent } from "@crumble/server/contract/reply-event";
import { Window } from "happy-dom";

const globals = Object.getOwnPropertyDescriptors(globalThis);

afterEach(() => {
  for (const key of [
    "window",
    "document",
    "localStorage",
    "location",
    "Notification",
  ]) {
    const original = globals[key];

    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});

type NotificationConstructor = new () => Partial<Notification>;

function browser(NotificationClass: NotificationConstructor) {
  const window = new Window({ url: "http://localhost/" });

  Object.defineProperty(NotificationClass, "permission", { value: "granted" });

  const values = {
    window: Object.assign(window, { Notification: NotificationClass }),
    document: window.document,
    localStorage: window.localStorage,
    location: window.location,
    Notification: NotificationClass,
  };

  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  localStorage.setItem("crumble.notification-sound", "off");

  return window;
}

const reply = (eventId: string) =>
  // SAFETY: notifyReply reads only the fields set here.
  ({
    eventId,
    agentId: "bot-1",
    origin: "chat",
    preview: "Done",
    agentName: "Ada",
  }) as ReplyEvent;

const links = { open: () => {}, pathOf: () => "/bots/bot-1" };

test("a browser that refuses notifications keeps the activity stream alive", async () => {
  browser(
    class {
      constructor() {
        throw new TypeError("Illegal constructor");
      }
    },
  );

  const { notifyReply } = await import("./notifications");

  expect(() => notifyReply(reply("refused"), links)).not.toThrow();
});

test("full storage keeps the activity stream alive", async () => {
  browser(class {});

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key === "crumble.notification-sound" ? "off" : null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    },
  });

  const { notifyReply } = await import("./notifications");

  expect(() => notifyReply(reply("full"), links)).not.toThrow();
});
