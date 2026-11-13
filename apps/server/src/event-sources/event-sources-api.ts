import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { EventSources } from "./event-sources";

export function registerEventSourceRoutes(options: {
  register: Register<Env, EventSources>;
}) {
  const { register } = options;

  register(routes.eventRelay, function* (c) {
    const sources = yield* EventSources;

    return c.json(yield* sources.relay, 200);
  });
  register(routes.updateEventRelay, function* (c) {
    const sources = yield* EventSources;

    return c.json(yield* sources.setRelayUrl(c.req.valid("json").url), 200);
  });
  register(routes.eventSources, function* (c) {
    const sources = yield* EventSources;

    return c.json({ sources: yield* sources.list }, 200);
  });
  register(routes.createEventSource, function* (c) {
    const sources = yield* EventSources;

    return c.json(yield* sources.create(c.req.valid("json").name), 201);
  });
  register(routes.deleteEventSource, function* (c) {
    const sources = yield* EventSources;

    yield* sources.remove(c.req.param("id"));

    return c.body(null, 204);
  });
}
