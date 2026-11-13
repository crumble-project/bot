import { Effect } from "effect";
import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import { secretRoutes } from "../bot-secrets/bot-secret-api";
import { Logins } from "./logins";

type LoginRoutesOptions = {
  register: Register<Env, Logins>;
  service: BotLookup;
};

export function registerLoginRoutes(options: LoginRoutesOptions) {
  const { register, service } = options;

  register(routes.agentLogins, function* (c) {
    const agentId = c.req.param("id");

    service.agent(agentId);
    const logins = yield* Logins;

    return c.json(
      yield* Effect.all({
        logins: logins.list(agentId),
        requests: logins.requests(agentId),
      }),
      200,
    );
  });
  const { secret, done } = secretRoutes(service);

  register(
    routes.saveAgentLogin,
    secret(function* (id, name, c) {
      const logins = yield* Logins;

      return c.json(yield* logins.save(id, name, c.req.valid("json")), 200);
    }),
  );
  register(
    routes.deleteAgentLogin,
    done((id, name) => Logins.use((s) => s.delete(id, name))),
  );
  register(
    routes.declineAgentLogin,
    done((id, name) => Logins.use((s) => s.decline(id, name))),
  );
  register(
    routes.agentLoginUses,
    secret(function* (id, name, c) {
      const logins = yield* Logins;

      return c.json(yield* logins.uses(id, name, c.req.valid("query")), 200);
    }),
  );
}
