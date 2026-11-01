import { and, asc, count, eq, lt } from "drizzle-orm";
import { agents } from "../bots/schema";
import { Context, Effect, Layer } from "effect";
import { schedules } from "../schedules/schema";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import {
  eventRuns,
  eventSources,
  relayEvents,
  type EventRunStatus,
} from "./schema";

export type EventSource = typeof eventSources.$inferSelect;

export type EventRun = typeof eventRuns.$inferSelect;

export type { EventRunStatus };

/** An event as the relay delivered it; `body` is the raw bytes in base64. */
export type RelayEvent = Omit<typeof relayEvents.$inferSelect, "storedAt">;

/** The account's event sources and the events that arrived at them. */
export class EventRepository extends Context.Service<
  EventRepository,
  {
    readonly listSources: Effect.Effect<EventSource[]>;
    readonly getSource: (id: string) => Effect.Effect<EventSource | null>;
    readonly addSource: (source: EventSource) => Effect.Effect<void>;
    readonly removeSource: (id: string) => Effect.Effect<boolean>;
    /** How many automations start from the source. */
    readonly sourceUsage: (id: string) => Effect.Effect<number>;
    /** Stores the event once, with a run for each enabled automation of an enabled bot on its source; a redelivery stores nothing. */
    readonly storeEvent: (
      event: RelayEvent,
    ) => Effect.Effect<{ stored: boolean; runs: number }>;
    /** The oldest pending run of each automation. */
    readonly nextPendingRuns: Effect.Effect<EventRun[]>;
    readonly markRun: (
      id: string,
      patch: Pick<EventRun, "status"> &
        Partial<Pick<EventRun, "attempts" | "error">>,
    ) => Effect.Effect<void>;
    /** Whether one of the bot's automations ran for the event. */
    readonly hasRunForAgent: (
      eventId: string,
      agentId: string,
    ) => Effect.Effect<boolean>;
    readonly getEvent: (id: string) => Effect.Effect<RelayEvent | null>;
    /** Deletes events stored before `before`, an ISO time. */
    readonly prune: (before: string) => Effect.Effect<number>;
  }
>()("crumble/event-sources/EventRepository") {
  static readonly layer = Layer.effect(
    EventRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const listSources = db
        .select()
        .from(eventSources)
        .orderBy(asc(eventSources.createdAt))
        .pipe(Effect.orDie);

      const getSource = Effect.fn("EventRepository.getSource")(function* (
        id: string,
      ) {
        const [row] = yield* db
          .select()
          .from(eventSources)
          .where(eq(eventSources.id, id));

        return row ?? null;
      }, Effect.orDie);

      const addSource = Effect.fn("EventRepository.addSource")(function* (
        source: EventSource,
      ) {
        yield* db.insert(eventSources).values(source);
      }, Effect.orDie);

      const removeSource = Effect.fn("EventRepository.removeSource")(function* (
        id: string,
      ) {
        const deleted = yield* db
          .delete(eventSources)
          .where(eq(eventSources.id, id))
          .returning({ id: eventSources.id });

        return deleted.length > 0;
      }, Effect.orDie);

      const sourceUsage = Effect.fn("EventRepository.sourceUsage")(function* (
        id: string,
      ) {
        const [row] = yield* db
          .select({ value: count() })
          .from(schedules)
          .where(eq(schedules.eventSourceId, id));

        return row?.value ?? 0;
      }, Effect.orDie);

      const storeEvent = Effect.fn("EventRepository.storeEvent")(function* (
        event: RelayEvent,
      ) {
        const now = yield* nowIso;

        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const rows = yield* tx
              .insert(relayEvents)
              .values({ ...event, storedAt: now })
              .onConflictDoNothing()
              .returning({ id: relayEvents.id });

            if (rows.length === 0) return { stored: false, runs: 0 };

            const automations = yield* tx
              .select({ id: schedules.id })
              .from(schedules)
              .innerJoin(agents, eq(agents.id, schedules.agentId))
              .where(
                and(
                  eq(schedules.eventSourceId, event.sourceId),
                  eq(schedules.enabled, true),
                  eq(agents.enabled, true),
                ),
              );

            if (automations.length)
              yield* tx.insert(eventRuns).values(
                automations.map((automation) => ({
                  id: crypto.randomUUID(),
                  eventId: event.id,
                  scheduleId: automation.id,
                  status: "pending" as const,
                  createdAt: now,
                })),
              );

            return { stored: true, runs: automations.length };
          }),
        );
      }, Effect.orDie);

      const nextPendingRuns = Effect.gen(function* () {
        const pending = yield* db
          .select()
          .from(eventRuns)
          .where(eq(eventRuns.status, "pending"))
          .orderBy(asc(eventRuns.eventId));

        const seen = new Set<string>();

        return pending.filter((run) => {
          if (seen.has(run.scheduleId)) return false;
          seen.add(run.scheduleId);

          return true;
        });
      }).pipe(Effect.orDie);

      const markRun = Effect.fn("EventRepository.markRun")(function* (
        id: string,
        patch: Pick<EventRun, "status"> &
          Partial<Pick<EventRun, "attempts" | "error">>,
      ) {
        yield* db.update(eventRuns).set(patch).where(eq(eventRuns.id, id));
      }, Effect.orDie);

      const hasRunForAgent = Effect.fn("EventRepository.hasRunForAgent")(
        function* (eventId: string, agentId: string) {
          const [row] = yield* db
            .select({ id: eventRuns.id })
            .from(eventRuns)
            .innerJoin(schedules, eq(schedules.id, eventRuns.scheduleId))
            .where(
              and(
                eq(eventRuns.eventId, eventId),
                eq(schedules.agentId, agentId),
              ),
            )
            .limit(1);

          return row !== undefined;
        },
        Effect.orDie,
      );

      const getEvent = Effect.fn("EventRepository.getEvent")(function* (
        id: string,
      ) {
        const [row] = yield* db
          .select()
          .from(relayEvents)
          .where(eq(relayEvents.id, id));

        if (!row) return null;
        const { storedAt: _, ...event } = row;

        return event;
      }, Effect.orDie);

      const prune = Effect.fn("EventRepository.prune")(function* (
        before: string,
      ) {
        const deleted = yield* db
          .delete(relayEvents)
          .where(lt(relayEvents.storedAt, before))
          .returning({ id: relayEvents.id });

        return deleted.length;
      }, Effect.orDie);

      return EventRepository.of({
        listSources,
        getSource,
        addSource,
        removeSource,
        sourceUsage,
        storeEvent,
        nextPendingRuns,
        markRun,
        hasRunForAgent,
        getEvent,
        prune,
      });
    }),
  );
}
