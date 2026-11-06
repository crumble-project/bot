import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { productLayer } from "../app/product-layer";
import { AgentRepository } from "../bot-store/agent-repository";
import { ScheduleRepository } from "./schedule-repository";
import { agentInput } from "../contract/agents";
import { scheduleInput } from "../contract/schedules";
import type { ProductDatabase } from "../shared/product-database";
import {
  EventConsumers,
  EventRepository,
  type RelayEvent,
} from "../event-sources/event-repository";
import { EventRunRepository } from "./event-run-repository";

const ada = "00000000-0000-4000-8000-000000000001";
const grace = "00000000-0000-4000-8000-000000000002";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const event = (id: string, sourceId = "source-1"): RelayEvent => ({
  id,
  sourceId,
  receivedAt: "2026-11-01T08:00:00.000Z",
  method: "POST",
  query: "",
  headers: [],
  body: "",
});

async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "crumble-event-repository-"));
  const runtime = ManagedRuntime.make(productLayer(folder));

  cleanups.push(async () => {
    await runtime.dispose();
    rmSync(folder, { recursive: true, force: true });
  });

  const run = <A>(
    effect: Effect.Effect<
      A,
      never,
      | EventRepository
      | EventRunRepository
      | ScheduleRepository
      | AgentRepository
      | ProductDatabase
    >,
  ) => runtime.runPromise(effect);

  const automation = (
    agentId: string,
    name: string,
    options: { sourceId?: string; enabled?: boolean } = {},
  ) =>
    run(
      ScheduleRepository.use((schedules) =>
        schedules.create(
          scheduleInput.parse({
            agentId,
            name,
            prompt: name,
            eventSourceId: options.sourceId ?? "source-1",
            enabled: options.enabled ?? true,
          }),
          null,
        ),
      ),
    ).then((schedule) => schedule.id);

  await run(
    Effect.gen(function* () {
      const repository = yield* AgentRepository;

      yield* repository.create(agentInput.parse({ name: "Ada" }), ada);
      yield* repository.create(
        agentInput.parse({ name: "Grace", enabled: false }),
        grace,
      );
    }),
  );

  const events = () => run(EventRepository.use(Effect.succeed));
  const runs = () => run(EventRunRepository.use(Effect.succeed));

  return { run, automation, events, runs };
}

test("storeEvent creates one run per enabled automation on the source", async () => {
  const { automation, events } = await fixture();

  await automation(ada, "Triage");
  await automation(ada, "Summarize");
  await automation(ada, "Paused", { enabled: false });
  await automation(grace, "Disabled bot");
  await automation(ada, "Other source", { sourceId: "source-2" });
  const repository = await events();

  expect(await Effect.runPromise(repository.storeEvent(event("01A")))).toEqual({
    stored: true,
    runs: 2,
  });
  expect(await Effect.runPromise(repository.storeEvent(event("01A")))).toEqual({
    stored: false,
    runs: 0,
  });
});

test("a run that cannot be recorded leaves no event, so the redelivery stores it", async () => {
  const { automation, events, run } = await fixture();

  await automation(ada, "Triage");
  const repository = await events();

  const crashing = Layer.fresh(EventRepository.layer).pipe(
    Layer.provide(
      Layer.succeed(
        EventConsumers,
        EventConsumers.of({
          stored: () => Effect.die("crashed"),
          usage: () => Effect.succeed(0),
        }),
      ),
    ),
  );

  const exit = await run(
    EventRepository.use((store) => store.storeEvent(event("01A"))).pipe(
      Effect.provide(crashing),
      Effect.exit,
    ),
  );

  expect(Exit.isFailure(exit)).toBeTrue();
  expect(await Effect.runPromise(repository.getEvent("01A"))).toBeNull();
  expect(await Effect.runPromise(repository.storeEvent(event("01A")))).toEqual({
    stored: true,
    runs: 1,
  });
});

test("nextPending returns the oldest pending run per automation", async () => {
  const { automation, events, runs } = await fixture();
  const triage = await automation(ada, "Triage");
  const repository = await events();
  const eventRunRepository = await runs();

  await Effect.runPromise(repository.storeEvent(event("01B")));
  await Effect.runPromise(repository.storeEvent(event("01A")));

  const [first, ...rest] = await Effect.runPromise(
    eventRunRepository.nextPending,
  );

  expect(rest).toEqual([]);
  expect(first).toMatchObject({
    eventId: "01A",
    scheduleId: triage,
    status: "pending",
    attempts: 0,
  });

  await Effect.runPromise(
    eventRunRepository.mark(first!.id, { status: "dispatched" }),
  );

  expect(
    (await Effect.runPromise(eventRunRepository.nextPending)).map(
      (run) => run.eventId,
    ),
  ).toEqual(["01B"]);
});

test("hasRunForAgent is true only for the bot whose automation ran", async () => {
  const { automation, events, runs } = await fixture();

  await automation(ada, "Triage");
  const repository = await events();
  const eventRunRepository = await runs();

  await Effect.runPromise(repository.storeEvent(event("01A")));

  expect(
    await Effect.runPromise(eventRunRepository.hasRunForAgent("01A", ada)),
  ).toBeTrue();
  expect(
    await Effect.runPromise(eventRunRepository.hasRunForAgent("01A", grace)),
  ).toBeFalse();
});

test("prune deletes events older than the cutoff with their runs", async () => {
  const { automation, events, runs } = await fixture();

  await automation(ada, "Triage");
  const repository = await events();
  const eventRunRepository = await runs();

  await Effect.runPromise(repository.storeEvent(event("01A")));

  expect(
    await Effect.runPromise(repository.prune("2026-11-01T08:00:00.000Z")),
  ).toBe(0);
  expect((await Effect.runPromise(repository.getEvent("01A")))?.id).toBe("01A");
  expect(
    await Effect.runPromise(repository.prune("2999-01-01T00:00:00.000Z")),
  ).toBe(1);
  expect(await Effect.runPromise(repository.getEvent("01A"))).toBeNull();
  expect(
    await Effect.runPromise(eventRunRepository.hasRunForAgent("01A", ada)),
  ).toBeFalse();
});
