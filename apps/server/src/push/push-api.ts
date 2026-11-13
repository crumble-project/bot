import { Effect } from "effect";
import type { Env } from "hono";
import { pushRoutes } from "../contract/push";
import type { Register } from "../contract/route";
import { NotFound } from "../shared/errors";
import { Push } from "./push";

export function registerPushRoutes(options: { register: Register<Env, Push> }) {
  const { register } = options;

  register(pushRoutes.pushStatus, function* (c) {
    const push = yield* Push;

    return c.json(
      {
        serverId: push.serverId,
        transports: {
          apns: !!push.transports.apns,
          fcm: !!push.transports.fcm,
        },
      },
      200,
    );
  });
  register(pushRoutes.putDevice, function* (c) {
    const push = yield* Push;

    return c.json(
      yield* push.device(
        c.req.valid("param").installationId,
        c.req.valid("json"),
      ),
      200,
    );
  });
  register(pushRoutes.deleteDevice, function* (c) {
    const push = yield* Push;

    yield* push.remove(c.req.valid("param").installationId);

    return c.body(null, 204);
  });
  register(pushRoutes.putPresence, function* (c) {
    const push = yield* Push;
    const input = c.req.valid("json");

    const registered = yield* push.presence(
      c.req.valid("param").installationId,
      input.active,
      input.agentId,
    );

    if (!registered)
      return yield* Effect.fail(
        new NotFound({ message: "Push device not found" }),
      );

    return c.body(null, 204);
  });
}
