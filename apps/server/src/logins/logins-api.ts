import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import type { Runner } from "../shared/runner";
import { secretRoutes } from "../bot-secrets/bot-secret-api";
import { Logins } from "./logins";

type LoginRoutesOptions = {
  register: Register;
  service: BotLookup;
  run: Runner<Logins>;
};

export function registerLoginRoutes(options: LoginRoutesOptions) {
  const { register, service, run } = options;

  register(routes.agentLogins, async (c) => {
    const agentId = c.req.param("id");

    service.agent(agentId);

    return c.json(
      await run.runPromise(
        Logins.use((s) =>
          Effect.all({
            logins: s.list(agentId),
            requests: s.requests(agentId),
          }),
        ),
      ),
      200,
    );
  });
  const { secret, done } = secretRoutes(service);

  const call: <A, E>(
    use: (service: Logins["Service"]) => Effect.Effect<A, E>,
  ) => Promise<A> = (use) => run.runPromise(Logins.use(use));

  register(
    routes.saveAgentLogin,
    secret(async (id, name, c) =>
      c.json(await call((s) => s.save(id, name, c.req.valid("json"))), 200),
    ),
  );
  register(
    routes.deleteAgentLogin,
    done((id, name) => call((s) => s.delete(id, name))),
  );
  register(
    routes.declineAgentLogin,
    done((id, name) => call((s) => s.decline(id, name))),
  );
  register(
    routes.agentLoginUses,
    secret(async (id, name, c) =>
      c.json(await call((s) => s.uses(id, name, c.req.valid("query"))), 200),
    ),
  );
}
