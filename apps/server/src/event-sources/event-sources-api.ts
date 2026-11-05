import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { Runner } from "../shared/runner";
import { EventSources } from "./event-sources";

/** The event relay's settings and the account's event sources. */
export function registerEventSourceRoutes(options: {
  register: Register;
  run: Runner<EventSources>;
}) {
  const { register, run } = options;

  register(routes.eventRelay, async (c) =>
    c.json(await run.runPromise(EventSources.use((s) => s.relay)), 200),
  );
  register(routes.updateEventRelay, async (c) =>
    c.json(
      await run.runPromise(
        EventSources.use((s) => s.setRelayUrl(c.req.valid("json").url)),
      ),
      200,
    ),
  );
  register(routes.eventSources, async (c) =>
    c.json(
      { sources: await run.runPromise(EventSources.use((s) => s.list)) },
      200,
    ),
  );
  register(routes.createEventSource, async (c) =>
    c.json(
      await run.runPromise(
        EventSources.use((s) => s.create(c.req.valid("json").name)),
      ),
      201,
    ),
  );
  register(routes.deleteEventSource, async (c) => {
    await run.runPromise(EventSources.use((s) => s.remove(c.req.param("id"))));

    return c.body(null, 204);
  });
}
