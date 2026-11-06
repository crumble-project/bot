import { botRequestApproval, routes } from "../contract/api-contract";
import type { Effect } from "effect";
import { pi } from "../shared/app-errors";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import { checkBotChoices } from "../bots/bot-choices";
import type { McpServers } from "../integrations/mcp-servers";
import type { Runner } from "../shared/runner";
import { BotRequests } from "./bot-requests";

type Options = {
  register: Register;
  service: BotLookup;
  botRequests: BotRequests["Service"];
  run: Runner<McpServers>;
  provider: { parse(value: string): string };
};

export function registerBotRequestRoutes(options: Options) {
  const { register, service, botRequests, run } = options;

  const exec = <A, E>(effect: Effect.Effect<A, E>) => run.runSync(effect);

  register(routes.listBotRequests, (c) => {
    service.agent(c.req.param("id"));

    return c.json(exec(botRequests.list(c.req.param("id"))), 200);
  });
  register(routes.approveBotRequest, async (c) => {
    const agentId = c.req.param("id");

    service.agent(agentId);

    return c.json(
      await run.runPromise(
        botRequests.approve(agentId, c.req.param("requestId"), (pending) =>
          pi(async () => {
            const raw = await c.req.text();

            const body = botRequestApproval.parse(
              raw.trim() ? JSON.parse(raw) : {},
            );

            const proposal = body.proposal ?? pending;

            await checkBotChoices(options, proposal, null);

            return proposal;
          }),
        ),
      ),
      200,
    );
  });
  register(routes.declineBotRequest, (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      exec(botRequests.decline(c.req.param("id"), c.req.param("requestId"))),
      200,
    );
  });
}
