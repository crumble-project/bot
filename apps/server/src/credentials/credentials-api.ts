import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import { secretRoutes } from "../bot-secrets/bot-secret-api";
import { Credentials } from "./credentials";

type CredentialRoutesOptions = {
  register: Register<Env, Credentials>;
  service: BotLookup;
};

export function registerCredentialRoutes(options: CredentialRoutesOptions) {
  const { register, service } = options;

  register(routes.agentCredentials, function* (c) {
    service.agent(c.req.param("id"));
    const credentials = yield* Credentials;

    return c.json(yield* credentials.list(c.req.param("id")), 200);
  });
  const { secret, done } = secretRoutes(service);

  register(
    routes.saveAgentCredential,
    secret(function* (id, name, c) {
      const credentials = yield* Credentials;

      return c.json(
        yield* credentials.save(id, name, c.req.valid("json")),
        200,
      );
    }),
  );
  register(
    routes.deleteAgentCredential,
    done((id, name) => Credentials.use((s) => s.delete(id, name))),
  );
  register(
    routes.declineAgentCredential,
    done((id, name) => Credentials.use((s) => s.decline(id, name))),
  );
  register(
    routes.agentCredentialUses,
    secret(function* (id, name, c) {
      const credentials = yield* Credentials;

      return c.json(
        yield* credentials.uses(id, name, c.req.valid("query")),
        200,
      );
    }),
  );
}
