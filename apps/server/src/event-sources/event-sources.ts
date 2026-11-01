import { Context, Effect, Layer } from "effect";
import { Conflict, NotFound, type AppError } from "../shared/errors";
import { SettingsRepository } from "../shared/settings-repository";
import { nowIso } from "../shared/time";
import { createSource, deleteSource } from "./doorstep-client";
import { EventRepository, type EventSource } from "./event-repository";
import { EventRelay, RELAY_URL_SETTING, type RelayStatus } from "./event-relay";

export type ListedEventSource = EventSource & { usedBy: number };

/** The owner's view of the event relay: its URL, and the sources Crumble creates on it. */
export class EventSources extends Context.Service<
  EventSources,
  {
    readonly relay: Effect.Effect<RelayStatus>;
    readonly setRelayUrl: (url: string | null) => Effect.Effect<RelayStatus>;
    readonly list: Effect.Effect<ListedEventSource[]>;
    /** The address carries the source's secret; nothing stores it, so it is shown only now. */
    readonly create: (
      name: string,
    ) => Effect.Effect<ListedEventSource & { address: string }, AppError>;
    readonly remove: (id: string) => Effect.Effect<void, AppError>;
  }
>()("crumble/event-sources/EventSources") {
  static readonly layer = Layer.effect(
    EventSources,
    Effect.gen(function* () {
      const settings = yield* SettingsRepository;
      const events = yield* EventRepository;
      const relay = yield* EventRelay;

      const setRelayUrl = Effect.fn("EventSources.setRelayUrl")(function* (
        url: string | null,
      ) {
        if (url) yield* settings.set(RELAY_URL_SETTING, url);
        else yield* settings.delete(RELAY_URL_SETTING);
        yield* relay.tick;

        return yield* relay.status;
      });

      const list = Effect.gen(function* () {
        return yield* Effect.forEach(yield* events.listSources, (source) =>
          Effect.map(events.sourceUsage(source.id), (usedBy) => ({
            ...source,
            usedBy,
          })),
        );
      });

      const create = Effect.fn("EventSources.create")(function* (name: string) {
        const created = yield* createSource(yield* relay.access);
        const source = { id: created.id, name, createdAt: yield* nowIso };
        yield* events.addSource(source);

        return { ...source, usedBy: 0, address: created.url };
      });

      const remove = Effect.fn("EventSources.remove")(function* (id: string) {
        if (!(yield* events.getSource(id)))
          return yield* new NotFound({ message: "Event source not found" });
        const usedBy = yield* events.sourceUsage(id);

        if (usedBy > 0)
          return yield* new Conflict({
            message: `Used by ${usedBy} ${usedBy === 1 ? "automation" : "automations"}`,
          });
        yield* deleteSource(yield* relay.access, id);
        yield* events.removeSource(id);
      });

      return EventSources.of({
        relay: relay.status,
        setRelayUrl,
        list,
        create,
        remove,
      });
    }),
  );
}
