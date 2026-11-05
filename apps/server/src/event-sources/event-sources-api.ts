import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { EventSources } from "./event-sources";

/** The event relay's settings and the account's event sources. */
export function registerEventSourceRoutes(options: {
  register: Register;
  eventSources: EventSources["Service"];
}) {
  const { register, eventSources } = options;

  register(routes.eventRelay, async (c) =>
    c.json(await Effect.runPromise(eventSources.relay), 200),
  );
  register(routes.updateEventRelay, async (c) =>
    c.json(
      await Effect.runPromise(
        eventSources.setRelayUrl(c.req.valid("json").url),
      ),
      200,
    ),
  );
  register(routes.eventSources, async (c) =>
    c.json({ sources: await Effect.runPromise(eventSources.list) }, 200),
  );
  register(routes.createEventSource, async (c) =>
    c.json(
      await Effect.runPromise(eventSources.create(c.req.valid("json").name)),
      201,
    ),
  );
  register(routes.deleteEventSource, async (c) => {
    await Effect.runPromise(eventSources.remove(c.req.param("id")));

    return c.body(null, 204);
  });
}
