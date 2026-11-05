import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { Push, PushDelivery } from "./push";
import {
  canonicalReplyEvent,
  type ReplyActivity,
} from "../contract/reply-event";
import { PushRepository } from "./push-repository";
import { PushTransports, type PushTransport } from "./push-transports";
import { BotActivity } from "../bots/bot-activity";
import type { Activity } from "../bots/bots";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const id = () => crypto.randomUUID();

type StoreProbe = { closes: number; failPending: number };

const observedRepository = (dir: string, probe: StoreProbe) =>
  Layer.effect(
    PushRepository,
    Effect.gen(function* () {
      const repository = yield* PushRepository;

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          probe.closes++;
        }),
      );

      return PushRepository.of({
        ...repository,
        pending: () =>
          Effect.suspend(() => {
            if (probe.failPending <= 0) return repository.pending();
            probe.failPending--;

            return Effect.die(new Error("outbox unreadable"));
          }),
      });
    }),
  ).pipe(Layer.provide(PushRepository.layer(dir)));

function activitySource() {
  let listener: ((event: Activity) => void) | undefined;
  let unsubscribes = 0;

  return {
    layer: Layer.succeed(BotActivity, {
      subscribe: (callback: (event: Activity) => void) => {
        listener = callback;

        return () => {
          unsubscribes++;
          listener = undefined;
        };
      },
    }),
    emit: (event: Activity) => listener?.(event),
    unsubscribes: () => unsubscribes,
  };
}

async function setup(transport: Omit<PushTransport, "canSend">) {
  const fcm = { canSend: () => true, ...transport };

  const dir = mkdtempSync(join("/tmp", "crumble-push-lifecycle-"));
  dirs.push(dir);
  const probe: StoreProbe = { closes: 0, failPending: 0 };
  const source = activitySource();

  const runtime = ManagedRuntime.make(
    PushDelivery.pipe(
      Layer.provideMerge(
        Push.layerNoDeps.pipe(
          Layer.provide(
            Layer.succeed(PushTransports, { fcm, apns: undefined }),
          ),
          Layer.provideMerge(observedRepository(dir, probe)),
        ),
      ),
      Layer.provide(source.layer),
      Layer.provideMerge(TestClock.layer()),
    ),
  );

  await runtime.runPromise(
    PushRepository.use((repository) =>
      repository.upsertDevice(id(), {
        platform: "android",
        transport: "fcm",
        token: "token",
        environment: "production",
        enabled: true,
      }),
    ),
  );

  return { runtime, probe, source };
}

const reply = (): ReplyActivity => ({
  type: "reply",
  executionId: id(),
  agentId: id(),
  agentName: "Bot",
  entryId: null,
  origin: "owner",
  preview: "Hello",
  createdAt: new Date().toISOString(),
});

const enqueueReply = Push.use((push) =>
  PushRepository.use((repository) =>
    repository.enqueue(canonicalReplyEvent(reply(), push.serverId)),
  ),
);

const delivering = (count: { sends: number }) => ({
  send: () =>
    Effect.sync(() => {
      count.sends++;

      return "delivered" as const;
    }),
});

describe("push lifecycle", () => {
  test("closing waits for a send in progress before closing the store", async () => {
    const release = Promise.withResolvers<void>();
    const order: string[] = [];

    const { runtime, probe } = await setup({
      send: () =>
        Effect.promise(async () => {
          order.push("send started");
          await release.promise;
          order.push("send finished");

          return "delivered" as const;
        }),
    });

    await runtime.runPromise(enqueueReply);
    const draining = runtime.runPromise(Push.use((push) => push.drain));
    await Bun.sleep(20);

    const closing = runtime.dispose().then(() => {
      order.push(`closed with ${probe.closes} store close`);
    });

    await Bun.sleep(20);
    expect(order).toEqual(["send started"]);
    expect(probe.closes).toBe(0);

    release.resolve();
    await Promise.allSettled([draining]);
    await closing;
    expect(order).toEqual([
      "send started",
      "send finished",
      "closed with 1 store close",
    ]);
  });

  test("a reply that arrives during a send is still delivered when closing", async () => {
    const release = Promise.withResolvers<void>();
    const sent: string[] = [];

    const { runtime, source } = await setup({
      send: (_device, event) =>
        Effect.promise(async () => {
          if (sent.length === 0) await release.promise;
          sent.push(event.eventId);

          return "delivered" as const;
        }),
    });

    const first = reply();
    const second = reply();
    source.emit(first);
    await Bun.sleep(20);
    source.emit(second);
    await Bun.sleep(20);

    const closing = runtime.dispose();
    await Bun.sleep(20);
    release.resolve();
    await closing;
    expect(sent).toEqual([first.executionId, second.executionId]);
  });

  test("closing twice resolves and closes the store once", async () => {
    const { runtime, probe, source } = await setup(delivering({ sends: 0 }));

    await runtime.dispose();
    await runtime.dispose();
    expect(probe.closes).toBe(1);
    expect(source.unsubscribes()).toBe(1);
  });

  test("closing still closes the store when the final delivery pass fails, and reports it", async () => {
    const { runtime, probe, source } = await setup(delivering({ sends: 0 }));

    probe.failPending = 1;

    await expect(runtime.dispose()).rejects.toThrow("outbox unreadable");
    expect(probe.closes).toBe(1);
    expect(source.unsubscribes()).toBe(1);
  });

  test("a failed background pass is logged, and polling delivers once the outbox reads again", async () => {
    let unhandled = 0;

    const onUnhandled = () => {
      unhandled++;
    };

    process.on("unhandledRejection", onUnhandled);
    const count = { sends: 0 };
    const { runtime, probe, source } = await setup(delivering(count));

    try {
      probe.failPending = 1;

      source.emit(reply());
      await Bun.sleep(50);
      expect(count.sends).toBe(0);

      await runtime.runPromise(TestClock.adjust("1 second"));
      await Bun.sleep(50);
      expect(count.sends).toBe(1);
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await runtime.dispose();
    }
  });
});
