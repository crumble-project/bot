import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  PushManager,
  PushStore,
  type PushTransport,
  type ReplyPushEvent,
} from "./push";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const id = () => crypto.randomUUID();

/** A store that counts closes and can fail its outbox reads on demand. */
class ObservedStore extends PushStore {
  closes = 0;
  failPending = 0;
  override pending(limit?: number) {
    if (this.failPending > 0) {
      this.failPending--;

      throw new Error("outbox unreadable");
    }

    return super.pending(limit);
  }
  override close() {
    this.closes++;
    super.close();
  }
}

function setup() {
  const dir = mkdtempSync(join("/tmp", "crumble-push-lifecycle-"));
  dirs.push(dir);
  const store = new ObservedStore(dir);
  const installationId = id();
  store.upsertDevice(installationId, {
    platform: "android",
    transport: "fcm",
    token: "token",
    environment: "production",
    enabled: true,
  });

  return { store, installationId };
}

const reply = (serverId: string): ReplyPushEvent => ({
  type: "reply",
  eventId: id(),
  serverId,
  agentId: id(),
  agentName: "Bot",
  entryId: null,
  origin: "owner",
  preview: "Hello",
  createdAt: new Date().toISOString(),
});

/** A service whose reply listener the test fires, recording unsubscribes. */
function activitySource() {
  let listener: ((event: ReplyPushEvent) => void) | undefined;
  let unsubscribes = 0;

  return {
    service: {
      onActivity(callback: (event: ReplyPushEvent) => void) {
        listener = callback;

        return () => {
          unsubscribes++;
          listener = undefined;
        };
      },
    },
    emit: (event: ReplyPushEvent) => listener?.(event),
    unsubscribes: () => unsubscribes,
  };
}

const transports = (fcm: PushTransport) => ({ fcm, apns: undefined });

describe("push manager lifecycle", () => {
  test("close waits for a send in progress before closing the store", async () => {
    const { store } = setup();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];

    const manager = new PushManager(
      store,
      transports({
        send: async () => {
          order.push("send started");
          await release.promise;
          order.push("send finished");

          return "delivered";
        },
      }),
    );

    store.enqueue(reply(manager.serverId));
    const draining = manager.drain();

    const closing = manager.close().then(() => {
      order.push(`closed with ${store.closes} store close`);
    });

    await Bun.sleep(20);
    expect(order).toEqual(["send started"]);
    expect(store.closes).toBe(0);

    release.resolve();
    await Promise.all([draining, closing]);
    expect(order).toEqual([
      "send started",
      "send finished",
      "closed with 1 store close",
    ]);
  });

  test("closing twice resolves and closes the store once", async () => {
    const { store } = setup();
    const source = activitySource();

    const manager = new PushManager(
      store,
      transports({ send: async () => "delivered" }),
    );

    manager.attach(source.service);

    await manager.close();
    await manager.close();
    expect(store.closes).toBe(1);
    expect(source.unsubscribes()).toBe(1);
  });

  test("close stops listening, so later replies are not sent", async () => {
    const { store } = setup();
    const source = activitySource();
    let sends = 0;

    const manager = new PushManager(
      store,
      transports({
        send: async () => {
          sends++;

          return "delivered";
        },
      }),
    );

    manager.attach(source.service);
    await manager.close();

    source.emit({ ...reply(manager.serverId), origin: "owner" });
    await Bun.sleep(20);
    expect(sends).toBe(0);
  });

  test("close still closes the store when the final delivery pass fails, and reports it", async () => {
    const { store } = setup();
    const source = activitySource();

    const manager = new PushManager(
      store,
      transports({ send: async () => "delivered" }),
    );

    manager.attach(source.service);
    store.failPending = 1;

    expect(manager.close()).rejects.toThrow("outbox unreadable");
    await Bun.sleep(20);
    expect(store.closes).toBe(1);
    expect(source.unsubscribes()).toBe(1);
  });

  test("a failed background pass is logged, and polling delivers once the outbox reads again", async () => {
    const { store } = setup();
    const source = activitySource();
    let unhandled = 0;

    const onUnhandled = () => {
      unhandled++;
    };

    process.on("unhandledRejection", onUnhandled);
    let sends = 0;

    const manager = new PushManager(
      store,
      transports({
        send: async () => {
          sends++;

          return "delivered";
        },
      }),
    );

    try {
      manager.attach(source.service);
      store.failPending = 1;

      // The reply's immediate pass fails; the next poll, a second later, delivers it.
      source.emit(reply(manager.serverId));
      await Bun.sleep(50);
      expect(sends).toBe(0);

      await Bun.sleep(1_500);
      expect(sends).toBe(1);
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await manager.close();
    }
  });
});
