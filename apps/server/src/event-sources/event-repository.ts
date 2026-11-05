import { asc, eq, lt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { eventSources, relayEvents } from "./schema";

export type EventSource = typeof eventSources.$inferSelect;

export const DELETED_SOURCE = "Deleted source";

/** An event as the relay delivered it; `body` is the raw bytes in base64. */
export type RelayEvent = Omit<typeof relayEvents.$inferSelect, "storedAt">;

/** What consumes stored events. Event sources stay below it: automations provide it. */
export class EventConsumers extends Context.Service<
  EventConsumers,
  {
    /** Runs inside the transaction that stores `event`, so a redelivery after a crash cannot lose what it records; answers how many runs it made. */
    readonly stored: (
      event: { id: string; sourceId: string },
      at: string,
    ) => Effect.Effect<number>;
    /** How many consumers use the source. */
    readonly usage: (sourceId: string) => Effect.Effect<number>;
  }
>()("crumble/event-sources/EventConsumers") {}

/** The account's event sources and the events that arrived at them. */
export class EventRepository extends Context.Service<
  EventRepository,
  {
    readonly listSources: Effect.Effect<EventSource[]>;
    readonly getSource: (id: string) => Effect.Effect<EventSource | null>;
    readonly addSource: (source: EventSource) => Effect.Effect<void>;
    readonly removeSource: (id: string) => Effect.Effect<boolean>;
    /** Stores the event once and hands it to its consumers in one transaction; a redelivery stores nothing. */
    readonly storeEvent: (
      event: RelayEvent,
    ) => Effect.Effect<{ stored: boolean; runs: number }>;
    readonly getEvent: (id: string) => Effect.Effect<RelayEvent | null>;
    /** A stored event and the name of its source, for what an automation reads. */
    readonly eventWithSource: (
      id: string,
    ) => Effect.Effect<{ record: RelayEvent; sourceName: string } | null>;
    /** Deletes events stored before `before`, an ISO time. */
    readonly prune: (before: string) => Effect.Effect<number>;
  }
>()("crumble/event-sources/EventRepository") {
  static readonly layer = Layer.effect(
    EventRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const consumers = yield* EventConsumers;

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

      const storeEvent = Effect.fn("EventRepository.storeEvent")(function* (
        event: RelayEvent,
      ) {
        const now = yield* nowIso;

        return yield* db.transaction(() =>
          Effect.gen(function* () {
            const rows = yield* db
              .insert(relayEvents)
              .values({ ...event, storedAt: now })
              .onConflictDoNothing()
              .returning({ id: relayEvents.id });

            if (rows.length === 0) return { stored: false, runs: 0 };

            return { stored: true, runs: yield* consumers.stored(event, now) };
          }),
        );
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

      const eventWithSource = Effect.fnUntraced(function* (id: string) {
        const record = yield* getEvent(id);

        if (!record) return null;
        const source = yield* getSource(record.sourceId);

        return { record, sourceName: source?.name ?? DELETED_SOURCE };
      });

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
        storeEvent,
        getEvent,
        eventWithSource,
        prune,
      });
    }),
  );
}
