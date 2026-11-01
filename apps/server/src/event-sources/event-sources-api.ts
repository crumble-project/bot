import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import { eventSourceInput, relayUrlInput } from "../contract/event-sources";
import type { Register } from "../contract/route";
import { Unavailable } from "../shared/errors";
import type { EventSources } from "./event-sources";

/** The event relay's settings and the account's event sources. */
export function registerEventSourceRoutes(options: {
  register: Register;
  eventSources?: EventSources["Service"] | undefined;
}) {
  const { register } = options;

  const service = () => {
    if (!options.eventSources)
      throw new Unavailable({ message: "Event sources aren't available" });

    return options.eventSources;
  };

  register(routes.eventRelay, async (c) =>
    c.json(await Effect.runPromise(service().relay), 200),
  );
  register(routes.updateEventRelay, async (c) => {
    const { url } = relayUrlInput.parse(await c.req.json());

    return c.json(await Effect.runPromise(service().setRelayUrl(url)), 200);
  });
  register(routes.eventSources, async (c) =>
    c.json({ sources: await Effect.runPromise(service().list) }, 200),
  );
  register(routes.createEventSource, async (c) => {
    const { name } = eventSourceInput.parse(await c.req.json());

    return c.json(await Effect.runPromise(service().create(name)), 201);
  });
  register(routes.deleteEventSource, async (c) => {
    await Effect.runPromise(service().remove(c.req.param("id")));

    return c.body(null, 204);
  });
}
