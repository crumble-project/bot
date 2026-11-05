import type { Register } from "../contract/route";
import { pushRoutes } from "../contract/push";
import { NotFound } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { Effect } from "effect";
import { Push } from "./push";

/** The owner's push routes: delivery status, device registration, and presence. */
export function registerPushRoutes(options: {
  register: Register;
  run: Runner<Push>;
}) {
  const { register, run } = options;
  const push = run.runSync(Push.use(Effect.succeed));

  register(pushRoutes.pushStatus, (c) =>
    c.json(
      {
        serverId: push.serverId,
        transports: {
          apns: !!push.transports.apns,
          fcm: !!push.transports.fcm,
        },
      },
      200,
    ),
  );
  register(pushRoutes.putDevice, async (c) =>
    c.json(
      await run.runPromise(
        push.device(c.req.valid("param").installationId, c.req.valid("json")),
      ),
      200,
    ),
  );
  register(pushRoutes.deleteDevice, async (c) => {
    await run.runPromise(push.remove(c.req.valid("param").installationId));

    return c.body(null, 204);
  });
  register(pushRoutes.putPresence, async (c) => {
    const input = c.req.valid("json");

    const registered = await run.runPromise(
      push.presence(
        c.req.valid("param").installationId,
        input.active,
        input.agentId,
      ),
    );

    if (!registered) throw new NotFound({ message: "Push device not found" });

    return c.body(null, 204);
  });
}
