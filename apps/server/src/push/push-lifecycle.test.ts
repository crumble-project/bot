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
import { until } from "../../test/support/until";
import { coreLayer } from "../app/core-layer";
import { Store } from "../../test/support/store";
import { PushDatabase } from "./push-database";
import { pushOutbox } from "./schema";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const id = () => crypto.randomUUID();

type StoreProbe = { closes: number; failPending: number };

const observedRepository = (probe: StoreProbe) =>
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
  ).pipe(Layer.provide(PushRepository.layerNoDeps));

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
          Layer.provideMerge(observedRepository(probe)),
        ),
      ),
      Layer.provide(source.layer),
      Layer.provideMerge(coreLayer(dir)),
      Layer.provideMerge(TestClock.layer()),
    ),
  );

  await runtime.runPromise(Effect.void);
  const store = new Store(runtime);
  store.createAgent(
    {
      name: "Bot",
      description: "",
      instructions: "help",
      provider: "openai",
      model: "gpt-4.1",
      enabled: true,
      tools: [],
      skills: [],
      mcpServers: [],
      delegates: [],
    },
    agentId,
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

  return { runtime, probe, source, dir };
}

const agentId = id();

const reply = (): ReplyActivity => ({
  type: "reply",
  executionId: id(),
  agentId,
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
    await runtime.runPromise(TestClock.adjust(3000));
    const draining = runtime.runPromise(Push.use((push) => push.drain));
    await until(() => order.length > 0);

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

  test("a reply that arrives during a send is persisted when closing", async () => {
    const release = Promise.withResolvers<void>();
    const sent: string[] = [];

    let sending = false;

    const { runtime, source, dir } = await setup({
      send: (_device, event) =>
        Effect.promise(async () => {
          sending = true;

          if (sent.length === 0) await release.promise;
          sent.push(event.eventId);

          return "delivered" as const;
        }),
    });

    const first = reply();
    const second = reply();
    source.emit(first);
    await until(
      async () =>
        (
          await runtime.runPromise(
            PushDatabase.use((db) =>
              db.select().from(pushOutbox).pipe(Effect.orDie),
            ),
          )
        ).length === 1,
    );
    await runtime.runPromise(TestClock.adjust(3000));
    await until(() => sending);
    source.emit(second);
    await until(
      async () =>
        (
          await runtime.runPromise(
            PushDatabase.use((db) =>
              db.select().from(pushOutbox).pipe(Effect.orDie),
            ),
          )
        ).length === 2,
    );

    const closing = runtime.dispose();
    await Bun.sleep(20);
    release.resolve();
    await closing;
    expect(sent).toEqual([first.executionId]);

    const restarted = ManagedRuntime.make(
      Push.layerNoDeps.pipe(
        Layer.provide(
          Layer.succeed(PushTransports, {
            apns: undefined,
            fcm: {
              canSend: () => true,
              send: (_device, event) =>
                Effect.sync(() => {
                  sent.push(event.eventId);
                  return "delivered" as const;
                }),
            },
          }),
        ),
        Layer.provideMerge(PushRepository.layerNoDeps),
        Layer.provideMerge(coreLayer(dir)),
        Layer.provideMerge(TestClock.layer()),
      ),
    );
    await restarted.runPromise(TestClock.setTime(6000));
    await restarted.runPromise(Push.use((push) => push.drain));
    expect(sent).toEqual([first.executionId, second.executionId]);
    await restarted.dispose();
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
      await until(() => probe.failPending === 0);
      expect(count.sends).toBe(0);

      await runtime.runPromise(TestClock.adjust("4 seconds"));
      await until(() => count.sends > 0);
      expect(count.sends).toBe(1);
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await runtime.dispose();
    }
  });
});
