import type { Env } from "hono";
import { pushRoutes } from "../contract/push";
import type { Register } from "../contract/route";
import { ChatAttention } from "./chat-attention";
import { Push } from "./push";

export function registerPushRoutes(options: {
  register: Register<Env, Push | ChatAttention>;
}) {
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
  register(pushRoutes.putView, function* (c) {
    yield* (yield* ChatAttention).view(
      c.req.valid("param").viewId,
      c.req.valid("json").chat,
    );

    return c.body(null, 204);
  });
  register(pushRoutes.postSeen, function* (c) {
    const input = c.req.valid("json");
    yield* (yield* ChatAttention).seen(input.chat, input.eventIds);

    return c.body(null, 204);
  });
}
