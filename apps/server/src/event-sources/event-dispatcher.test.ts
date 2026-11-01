import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { productLayer } from "../app/product-layer";
import { AgentRepository } from "../bots/agent-repository";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { TaskDispatch } from "../schedules/task-dispatch";
import { agentInput, scheduleInput } from "../shared/domain";
import {
  EVENT_MAX_ATTEMPTS,
  EVENT_RETRY_AFTER_MS,
  EventDispatcher,
} from "./event-dispatcher";
import { EventRepository, type RelayEvent } from "./event-repository";
import { eventRequestId } from "./event-payload";

const ada = "00000000-0000-4000-8000-000000000001";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const event = (id: string): RelayEvent => ({
  id,
  sourceId: "source-1",
  receivedAt: "2026-11-01T08:00:00.000Z",
  method: "POST",
  query: "",
  headers: [],
  body: "",
});

async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "crumble-event-dispatcher-"));
  const dispatched: { prompt: string; requestId: string }[] = [];
  let failing = false;

  const dispatch = Layer.succeed(TaskDispatch, (_agentId, prompt, requestId) =>
    failing
      ? Effect.fail(new Error("chat unavailable"))
      : Effect.sync(() => {
          dispatched.push({ prompt, requestId });
        }),
  );

  const runtime = ManagedRuntime.make(
    EventDispatcher.layer.pipe(
      Layer.provideMerge(dispatch),
      Layer.provideMerge(productLayer(folder)),
      Layer.provideMerge(TestClock.layer()),
    ),
  );

  cleanups.push(async () => {
    await runtime.dispose();
    rmSync(folder, { recursive: true, force: true });
  });

  const run = <A>(
    effect: Effect.Effect<
      A,
      never,
      EventDispatcher | EventRepository | ScheduleRepository | AgentRepository
    >,
  ) => runtime.runPromise(effect);

  await run(
    Effect.gen(function* () {
      yield* (yield* AgentRepository).create(
        agentInput.parse({ name: "Ada" }),
        ada,
      );
      yield* (yield* EventRepository).addSource({
        id: "source-1",
        name: "GitHub",
        createdAt: "2026-11-01T00:00:00.000Z",
      });
    }),
  );

  const automation = (overrides: { enabled?: boolean } = {}) =>
    run(
      ScheduleRepository.use((schedules) =>
        schedules.create(
          scheduleInput.parse({
            agentId: ada,
            name: "Triage",
            prompt: "Triage the issue",
            eventSourceId: "source-1",
            ...overrides,
          }),
        ),
      ),
    );

  const store = (id: string) =>
    run(EventRepository.use((events) => events.storeEvent(event(id))));

  const tick = () => run(EventDispatcher.use((dispatcher) => dispatcher.tick));

  const pending = () =>
    run(EventRepository.use((events) => events.nextPendingRuns));

  const advance = (ms: number) => run(TestClock.adjust(ms));

  return {
    dispatched,
    automation,
    store,
    tick,
    pending,
    advance,
    fail: (value: boolean) => {
      failing = value;
    },
    run,
  };
}

test("pending prompt runs are dispatched in event order with their request IDs", async () => {
  const { automation, store, tick, dispatched, pending } = await fixture();
  const schedule = await automation();

  await store("01A");
  await store("01B");
  await tick();

  expect(dispatched).toEqual([
    {
      prompt: "Triage the issue",
      requestId: eventRequestId("01A", schedule.id),
    },
  ]);

  await tick();
  expect(dispatched.map((entry) => entry.requestId)).toEqual([
    eventRequestId("01A", schedule.id),
    eventRequestId("01B", schedule.id),
  ]);
  expect(await pending()).toEqual([]);
});

test("a failing dispatch waits before it retries and gives up after the last attempt", async () => {
  const { automation, store, tick, dispatched, pending, advance, fail } =
    await fixture();

  const schedule = await automation();

  await store("01A");
  await store("01B");
  fail(true);
  await tick();

  expect(await pending()).toMatchObject([
    { eventId: "01A", attempts: 1, error: "chat unavailable" },
  ]);

  await tick();
  expect((await pending())[0]?.attempts).toBe(1);

  for (let attempt = 2; attempt <= EVENT_MAX_ATTEMPTS; attempt++) {
    await advance(EVENT_RETRY_AFTER_MS);
    await tick();
  }

  expect(await pending()).toMatchObject([{ eventId: "01B", attempts: 0 }]);

  fail(false);
  await tick();
  expect(dispatched.map((entry) => entry.requestId)).toEqual([
    eventRequestId("01B", schedule.id),
  ]);
});

test("a run whose automation was turned off fails without dispatching", async () => {
  const { automation, store, tick, dispatched, pending, run } = await fixture();
  const schedule = await automation();

  await store("01A");
  await run(
    ScheduleRepository.use((schedules) =>
      schedules.update(schedule.id, { enabled: false }),
    ),
  );
  await tick();

  expect(dispatched).toEqual([]);
  expect(await pending()).toEqual([]);
});
