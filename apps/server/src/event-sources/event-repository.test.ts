import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Effect, ManagedRuntime } from "effect";
import { productLayer } from "../app/product-layer";
import { AgentRepository } from "../bots/agent-repository";
import { agents } from "../bots/schema";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { schedules } from "../schedules/schema";
import { agentInput, scheduleInput } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { EventRepository, type RelayEvent } from "./event-repository";
import { eventRuns } from "./schema";

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
      EventRepository | ScheduleRepository | AgentRepository | ProductDatabase
    >,
  ) => runtime.runPromise(effect);

  const automation = (
    agentId: string,
    name: string,
    options: { sourceId?: string; enabled?: boolean } = {},
  ) =>
    run(
      Effect.gen(function* () {
        const schedule = yield* (yield* ScheduleRepository).create(
          scheduleInput.parse({
            agentId,
            name,
            prompt: name,
            cron: "0 9 * * *",
            enabled: options.enabled ?? true,
          }),
        );

        yield* ProductDatabase.use((db) =>
          db
            .update(schedules)
            .set({ eventSourceId: options.sourceId ?? "source-1" })
            .where(eq(schedules.id, schedule.id))
            .pipe(Effect.orDie),
        );

        return schedule.id;
      }),
    );

  await run(
    Effect.gen(function* () {
      const repository = yield* AgentRepository;

      yield* repository.create(agentInput.parse({ name: "Ada" }), ada);
      yield* repository.create(agentInput.parse({ name: "Grace" }), grace);
      yield* ProductDatabase.use((db) =>
        db
          .update(agents)
          .set({ enabled: false })
          .where(eq(agents.id, grace))
          .pipe(Effect.orDie),
      );
    }),
  );

  const events = () => run(EventRepository.use(Effect.succeed));

  return { run, automation, events };
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

test("nextPendingRuns returns the oldest pending run per automation", async () => {
  const { automation, events } = await fixture();
  const triage = await automation(ada, "Triage");
  const repository = await events();

  await Effect.runPromise(repository.storeEvent(event("01B")));
  await Effect.runPromise(repository.storeEvent(event("01A")));

  const [first, ...rest] = await Effect.runPromise(repository.nextPendingRuns);

  expect(rest).toEqual([]);
  expect(first).toMatchObject({
    eventId: "01A",
    scheduleId: triage,
    status: "pending",
    attempts: 0,
  });

  await Effect.runPromise(
    repository.markRun(first!.id, { status: "dispatched" }),
  );

  expect(
    (await Effect.runPromise(repository.nextPendingRuns)).map(
      (run) => run.eventId,
    ),
  ).toEqual(["01B"]);
});

test("hasRunForAgent is true only for the bot whose automation ran", async () => {
  const { automation, events } = await fixture();

  await automation(ada, "Triage");
  const repository = await events();

  await Effect.runPromise(repository.storeEvent(event("01A")));

  expect(
    await Effect.runPromise(repository.hasRunForAgent("01A", ada)),
  ).toBeTrue();
  expect(
    await Effect.runPromise(repository.hasRunForAgent("01A", grace)),
  ).toBeFalse();
});

test("prune deletes old events with their runs", async () => {
  const { automation, events, run } = await fixture();

  await automation(ada, "Triage");
  const repository = await events();

  await Effect.runPromise(repository.storeEvent(event("01A")));

  expect(
    await Effect.runPromise(repository.prune("2999-01-01T00:00:00.000Z")),
  ).toBe(1);
  expect(await Effect.runPromise(repository.getEvent("01A"))).toBeNull();
  expect(
    await run(
      ProductDatabase.use((db) =>
        db.select().from(eventRuns).pipe(Effect.orDie),
      ),
    ),
  ).toEqual([]);
});
