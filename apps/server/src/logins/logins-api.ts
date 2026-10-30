import { routes, credentialUsesInput } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotsAccess } from "../bots/bots";
import { loginSaveInput } from "../shared/domain";
import type { LoginsAccess } from "./logins";

type LoginRoutesOptions = {
  register: Register;
  service: Pick<BotsAccess, "agent">;
  logins: LoginsAccess;
};

/** The logins one bot's desktop jobs may fill: listing them with the bot's requests, saving, deleting, declining, and the fill log. */
export function registerLoginRoutes(options: LoginRoutesOptions) {
  const { register, service, logins } = options;

  register(routes.agentLogins, (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      {
        logins: logins.list(c.req.param("id")),
        requests: logins.requests(c.req.param("id")),
      },
      200,
    );
  });
  register(routes.saveAgentLogin, async (c) => {
    service.agent(c.req.param("id"));
    const input = loginSaveInput.parse(await c.req.json());

    return c.json(
      await logins.save(c.req.param("id"), c.req.param("name"), input),
      200,
    );
  });
  register(routes.deleteAgentLogin, async (c) => {
    service.agent(c.req.param("id"));
    await logins.delete(c.req.param("id"), c.req.param("name"));

    return c.body(null, 204);
  });
  register(routes.declineAgentLogin, async (c) => {
    service.agent(c.req.param("id"));
    await logins.decline(c.req.param("id"), c.req.param("name"));

    return c.body(null, 204);
  });
  register(routes.agentLoginUses, (c) => {
    service.agent(c.req.param("id"));
    const query = credentialUsesInput.parse(c.req.query());

    return c.json(
      logins.uses(c.req.param("id"), c.req.param("name"), query),
      200,
    );
  });
}
