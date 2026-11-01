import { asc, count, eq, lt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { schedules } from "../schedules/schema";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { eventSources, relayEvents } from "./schema";

export type EventSource = typeof eventSources.$inferSelect;

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
    /** Stores the event once; `stored` is false for a redelivery. */
    readonly storeEvent: (
      event: RelayEvent,
    ) => Effect.Effect<{ stored: boolean }>;
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
        const rows = yield* db
          .insert(relayEvents)
          .values({ ...event, storedAt: yield* nowIso })
          .onConflictDoNothing()
          .returning({ id: relayEvents.id });

        return { stored: rows.length > 0 };
      }, Effect.orDie);

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
        getEvent,
        prune,
      });
    }),
  );
}
