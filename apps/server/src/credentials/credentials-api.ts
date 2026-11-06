import type { Effect } from "effect";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import type { Runner } from "../shared/runner";
import { secretRoutes } from "../bot-secrets/bot-secret-api";
import { Credentials } from "./credentials";

type CredentialRoutesOptions = {
  register: Register;
  service: BotLookup;
  run: Runner<Credentials>;
};

export function registerCredentialRoutes(options: CredentialRoutesOptions) {
  const { register, service, run } = options;

  register(routes.agentCredentials, async (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      await run.runPromise(Credentials.use((s) => s.list(c.req.param("id")))),
      200,
    );
  });
  const { secret, done } = secretRoutes(service);

  const call: <A, E>(
    use: (service: Credentials["Service"]) => Effect.Effect<A, E>,
  ) => Promise<A> = (use) => run.runPromise(Credentials.use(use));

  register(
    routes.saveAgentCredential,
    secret(async (id, name, c) =>
      c.json(await call((s) => s.save(id, name, c.req.valid("json"))), 200),
    ),
  );
  register(
    routes.deleteAgentCredential,
    done((id, name) => call((s) => s.delete(id, name))),
  );
  register(
    routes.declineAgentCredential,
    done((id, name) => call((s) => s.decline(id, name))),
  );
  register(
    routes.agentCredentialUses,
    secret(async (id, name, c) =>
      c.json(await call((s) => s.uses(id, name, c.req.valid("query"))), 200),
    ),
  );
}
