import { and, asc, count, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { agents } from "../bot-store/schema";
import { EventConsumers } from "../event-sources/event-repository";
import { ProductDatabase } from "../shared/product-database";
import { schedules } from "../bot-store/schema.schedules";
import { eventRuns } from "./schema.event-runs";

export type EventRun = typeof eventRuns.$inferSelect;

export class EventRunRepository extends Context.Service<
  EventRunRepository,
  {
    readonly sourceUsage: (sourceId: string) => Effect.Effect<number>;
    /** A run for each enabled automation of an enabled bot on the event's source. */
    readonly record: (
      event: { id: string; sourceId: string },
      at: string,
    ) => Effect.Effect<number>;
    readonly nextPending: Effect.Effect<EventRun[]>;
    readonly mark: (
      id: string,
      patch: Pick<EventRun, "status"> &
        Partial<Pick<EventRun, "attempts" | "error">>,
    ) => Effect.Effect<void>;
    readonly hasRunForAgent: (
      eventId: string,
      agentId: string,
    ) => Effect.Effect<boolean>;
  }
>()("crumble/automations/EventRunRepository") {
  static readonly layer = Layer.effect(
    EventRunRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const sourceUsage = Effect.fn("EventRunRepository.sourceUsage")(
        function* (sourceId: string) {
          const [row] = yield* db
            .select({ value: count() })
            .from(schedules)
            .where(eq(schedules.eventSourceId, sourceId));

          return row?.value ?? 0;
        },
        Effect.orDie,
      );

      const record = Effect.fn("EventRunRepository.record")(function* (
        event: { id: string; sourceId: string },
        at: string,
      ) {
        const automations = yield* db
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
          yield* db.insert(eventRuns).values(
            automations.map((automation) => ({
              id: crypto.randomUUID(),
              eventId: event.id,
              scheduleId: automation.id,
              status: "pending" as const,
              createdAt: at,
            })),
          );

        return automations.length;
      }, Effect.orDie);

      const nextPending = Effect.gen(function* () {
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

      const mark = Effect.fn("EventRunRepository.mark")(function* (
        id: string,
        patch: Pick<EventRun, "status"> &
          Partial<Pick<EventRun, "attempts" | "error">>,
      ) {
        yield* db.update(eventRuns).set(patch).where(eq(eventRuns.id, id));
      }, Effect.orDie);

      const hasRunForAgent = Effect.fn("EventRunRepository.hasRunForAgent")(
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

      return EventRunRepository.of({
        sourceUsage,
        record,
        nextPending,
        mark,
        hasRunForAgent,
      });
    }),
  );
}

export const automationEventConsumers = Layer.effect(
  EventConsumers,
  EventRunRepository.use(({ record, sourceUsage }) =>
    Effect.succeed(EventConsumers.of({ stored: record, usage: sourceUsage })),
  ),
);
