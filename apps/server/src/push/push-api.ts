import { z } from "zod";
import type { Register } from "../contract/route";
import { AppError } from "../shared/domain";
import type { PushDeviceInput, PushManager } from "./push";
import { presenceInput, pushInput, pushRoutes } from "./push-contract";

/** The owner's push routes: delivery status, device registration, and presence. Without a manager, push is unavailable. */
export function registerPushRoutes(
  register: Register,
  push: PushManager | undefined,
) {
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
    if (!push) throw new AppError(503, "Push delivery is unavailable");

    const installationId = z
      .string()
      .uuid()
      .parse(c.req.param("installationId"));

    const input: PushDeviceInput = pushInput.parse(await c.req.json());

    return c.json(push.device(installationId, input), 200);
  });
  register(pushRoutes.deleteDevice, (c) => {
    push?.remove(z.string().uuid().parse(c.req.param("installationId")));

    return c.body(null, 204);
  });
  register(pushRoutes.putPresence, async (c) => {
    if (!push) throw new AppError(503, "Push delivery is unavailable");
    const id = z.string().uuid().parse(c.req.param("installationId"));

    const input = presenceInput.parse(await c.req.json());

    if (!push.presence(id, input.active, input.agentId))
      throw new AppError(404, "Push device not found");

    return c.body(null, 204);
  });
}
