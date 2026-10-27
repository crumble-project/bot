import { routes, credentialUsesInput } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { CredentialsAccess } from "./credentials";
import type { BotsAccess } from "../bots/bots";
import { credentialSaveInput } from "../shared/domain";

type CredentialRoutesOptions = {
  register: Register;
  service: BotsAccess;
  credentials: CredentialsAccess;
};

/** The credentials one bot may use: listing them, saving one, deleting one, and its use log. */
export function registerCredentialRoutes(options: CredentialRoutesOptions) {
  const { register, service, credentials } = options;

  register(routes.agentCredentials, (c) => {
    service.agent(c.req.param("id"));

    return c.json(credentials.list(c.req.param("id")), 200);
  });
  register(routes.saveAgentCredential, async (c) => {
    service.agent(c.req.param("id"));
    const input = credentialSaveInput.parse(await c.req.json());

    return c.json(
      await credentials.save(c.req.param("id"), c.req.param("name"), input),
      200,
    );
  });
  register(routes.deleteAgentCredential, async (c) => {
    service.agent(c.req.param("id"));
    await credentials.delete(c.req.param("id"), c.req.param("name"));

    return c.body(null, 204);
  });
  register(routes.declineAgentCredential, async (c) => {
    service.agent(c.req.param("id"));
    await credentials.decline(c.req.param("id"), c.req.param("name"));

    return c.body(null, 204);
  });
  register(routes.agentCredentialUses, (c) => {
    service.agent(c.req.param("id"));
    const query = credentialUsesInput.parse(c.req.query());

    return c.json(
      credentials.uses(c.req.param("id"), c.req.param("name"), query),
      200,
    );
  });
}
