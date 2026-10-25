import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { Push, PushDelivery } from "./push";
import { canonicalReplyEvent } from "./push-model";
import { PushRepository } from "./push-repository";
import { PushTransports, type PushTransport } from "./push-transports";
import { BotActivity } from "../bots/bot-activity";
import type { Activity, ReplyActivity } from "../bots/service";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const id = () => crypto.randomUUID();

/** What the test observes of the store: how often it closed, and outbox reads it should fail. */
type StoreProbe = { closes: number; failPending: number };

/** The real repository, counting its closes and failing outbox reads on demand. */
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
        pending: (limit) =>
          Effect.suspend(() => {
            if (probe.failPending <= 0) return repository.pending(limit);
            probe.failPending--;

            return Effect.die(new Error("outbox unreadable"));
          }),
      });
    }),
  ).pipe(Layer.provide(PushRepository.layer(dir)));

/** A source of activity the test fires, recording unsubscribes. */
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

/** Push with delivery attached, over one device registered for `fcm`. */
async function setup(fcm: PushTransport) {
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

const delivering = (count: { sends: number }): PushTransport => ({
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
    // Disposing interrupts the caller waiting on the pass; the pass itself finishes before the store closes.
    await Promise.allSettled([draining]);
    await closing;
    expect(order).toEqual([
      "send started",
      "send finished",
      "closed with 1 store close",
    ]);
  });

  test("closing twice resolves and closes the store once", async () => {
    const { runtime, probe, source } = await setup(delivering({ sends: 0 }));

    await runtime.dispose();
    await runtime.dispose();
    expect(probe.closes).toBe(1);
    expect(source.unsubscribes()).toBe(1);
  });

  test("closing stops listening, so later replies are not sent", async () => {
    const count = { sends: 0 };
    const { runtime, source } = await setup(delivering(count));

    await runtime.dispose();

    source.emit(reply());
    await Bun.sleep(20);
    expect(count.sends).toBe(0);
  });

  test("closing still closes the store when the final delivery pass fails, and reports it", async () => {
    const { runtime, probe, source } = await setup(delivering({ sends: 0 }));

    probe.failPending = 1;

    expect(runtime.dispose()).rejects.toThrow("outbox unreadable");
    await Bun.sleep(20);
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

      // The reply's immediate pass fails; the next poll, a second later, delivers it.
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
