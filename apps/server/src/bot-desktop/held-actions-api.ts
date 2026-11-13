import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import type { HeldActionsAccess } from "./held-actions";

type HeldActionRoutesOptions = {
  register: Register;
  service: BotLookup;
  held: HeldActionsAccess;
};

export function registerHeldActionRoutes(options: HeldActionRoutesOptions) {
  const { register, service, held } = options;

  register.plain(routes.agentHeldActions, (c) => {
    service.agent(c.req.param("id"));

    return c.json(held.list(c.req.param("id")), 200);
  });
  register.plain(routes.approveAgentHeldAction, async (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      await held.decide(c.req.param("id"), c.req.param("actionId"), {
        status: "approved",
      }),
      200,
    );
  });
  register.plain(routes.declineAgentHeldAction, async (c) => {
    service.agent(c.req.param("id"));
    const { reason } = c.req.valid("json");

    return c.json(
      await held.decide(c.req.param("id"), c.req.param("actionId"), {
        status: "declined",
        reason: reason || null,
      }),
      200,
    );
  });
}
