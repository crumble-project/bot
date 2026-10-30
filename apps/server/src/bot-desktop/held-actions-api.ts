import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotsAccess } from "../bots/bots";
import { heldActionDeclineInput } from "../shared/domain";
import type { HeldActionsAccess } from "./held-actions";

type HeldActionRoutesOptions = {
  register: Register;
  service: Pick<BotsAccess, "agent">;
  held: HeldActionsAccess;
};

/** One bot's held actions: the list its chat cards read, and the owner's approve and decline. */
export function registerHeldActionRoutes(options: HeldActionRoutesOptions) {
  const { register, service, held } = options;

  register(routes.agentHeldActions, (c) => {
    service.agent(c.req.param("id"));

    return c.json(held.list(c.req.param("id")), 200);
  });
  register(routes.approveAgentHeldAction, async (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      await held.decide(c.req.param("id"), c.req.param("actionId"), {
        status: "approved",
      }),
      200,
    );
  });
  register(routes.declineAgentHeldAction, async (c) => {
    service.agent(c.req.param("id"));
    const input = heldActionDeclineInput.parse(await c.req.json());

    return c.json(
      await held.decide(c.req.param("id"), c.req.param("actionId"), {
        status: "declined",
        reason: input.reason || null,
      }),
      200,
    );
  });
}
