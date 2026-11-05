import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotsAccess } from "../bots/bots";
import type { Runner } from "../shared/runner";
import { Credentials } from "./credentials";

type CredentialRoutesOptions = {
  register: Register;
  service: BotsAccess;
  run: Runner<Credentials>;
};

/** The credentials one bot may use: listing them, saving one, deleting one, and its use log. */
export function registerCredentialRoutes(options: CredentialRoutesOptions) {
  const { register, service, run } = options;

  register(routes.agentCredentials, async (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      await run.runPromise(Credentials.use((s) => s.list(c.req.param("id")))),
      200,
    );
  });
  register(routes.saveAgentCredential, async (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      await run.runPromise(
        Credentials.use((s) =>
          s.save(c.req.param("id"), c.req.param("name"), c.req.valid("json")),
        ),
      ),
      200,
    );
  });
  register(routes.deleteAgentCredential, async (c) => {
    service.agent(c.req.param("id"));
    await run.runPromise(
      Credentials.use((s) => s.delete(c.req.param("id"), c.req.param("name"))),
    );

    return c.body(null, 204);
  });
  register(routes.declineAgentCredential, async (c) => {
    service.agent(c.req.param("id"));
    await run.runPromise(
      Credentials.use((s) => s.decline(c.req.param("id"), c.req.param("name"))),
    );

    return c.body(null, 204);
  });
  register(routes.agentCredentialUses, async (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      await run.runPromise(
        Credentials.use((s) =>
          s.uses(c.req.param("id"), c.req.param("name"), c.req.valid("query")),
        ),
      ),
      200,
    );
  });
}
