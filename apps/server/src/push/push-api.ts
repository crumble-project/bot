import { z } from "zod";
import type { Register } from "../contract/route";
import { AppError } from "../shared/domain";
import { Effect } from "effect";
import { Push, type PushRuntime } from "./push";
import type { PushDeviceInput } from "./push-model";
import { presenceInput, pushInput, pushRoutes } from "./push-contract";

/** The owner's push routes: delivery status, device registration, and presence. Without a runtime, push is unavailable. */
export function registerPushRoutes(
  register: Register,
  runtime: PushRuntime | undefined,
) {
  const push = runtime?.runSync(Push.use(Effect.succeed));

  register(pushRoutes.pushStatus, (c) =>
    c.json(
      {
        serverId: push?.serverId ?? "",
        transports: {
          apns: !!push?.transports.apns,
          fcm: !!push?.transports.fcm,
        },
      },
      200,
    ),
  );
  register(pushRoutes.putDevice, async (c) => {
    if (!runtime) throw new AppError(503, "Push delivery is unavailable");

    const installationId = z.uuid().parse(c.req.param("installationId"));

    const input: PushDeviceInput = pushInput.parse(await c.req.json());

    return c.json(
      await runtime.runPromise(
        Push.use((service) => service.device(installationId, input)),
      ),
      200,
    );
  });
  register(pushRoutes.deleteDevice, async (c) => {
    const installationId = z.uuid().parse(c.req.param("installationId"));

    await runtime?.runPromise(
      Push.use((service) => service.remove(installationId)),
    );

    return c.body(null, 204);
  });
  register(pushRoutes.putPresence, async (c) => {
    if (!runtime) throw new AppError(503, "Push delivery is unavailable");
    const id = z.uuid().parse(c.req.param("installationId"));

    const input = presenceInput.parse(await c.req.json());

    const registered = await runtime.runPromise(
      Push.use((service) => service.presence(id, input.active, input.agentId)),
    );

    if (!registered) throw new AppError(404, "Push device not found");

    return c.body(null, 204);
  });
}
