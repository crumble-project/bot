import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import type { Runner } from "../shared/runner";
import { Logins } from "./logins";

type LoginRoutesOptions = {
  register: Register;
  service: BotLookup;
  run: Runner<Logins>;
};

/** The logins one bot's desktop jobs may fill: listing them with the bot's requests, saving, deleting, declining, and the fill log. */
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
  register(routes.saveAgentLogin, async (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      await run.runPromise(
        Logins.use((s) =>
          s.save(c.req.param("id"), c.req.param("name"), c.req.valid("json")),
        ),
      ),
      200,
    );
  });
  register(routes.deleteAgentLogin, async (c) => {
    service.agent(c.req.param("id"));
    await run.runPromise(
      Logins.use((s) => s.delete(c.req.param("id"), c.req.param("name"))),
    );

    return c.body(null, 204);
  });
  register(routes.declineAgentLogin, async (c) => {
    service.agent(c.req.param("id"));
    await run.runPromise(
      Logins.use((s) => s.decline(c.req.param("id"), c.req.param("name"))),
    );

    return c.body(null, 204);
  });
  register(routes.agentLoginUses, async (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      await run.runPromise(
        Logins.use((s) =>
          s.uses(c.req.param("id"), c.req.param("name"), c.req.valid("query")),
        ),
      ),
      200,
    );
  });
}
