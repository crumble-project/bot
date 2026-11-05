import { routes } from "../contract/api-contract";
import type { Effect } from "effect";
import { pi } from "../shared/app-errors";
import type { Register } from "../contract/route";
import type { BotsAccess } from "../bots/bots";
import type { McpServers } from "../integrations/mcp-servers";
import type { Runner } from "../shared/runner";
import { BotRequests } from "./bot-requests";
import { z } from "zod";
import { agentInput } from "../shared/domain";

type Options = {
  register: Register;
  service: BotsAccess;
  /** Without it, the routes are not registered. */
  botRequests?: BotRequests["Service"] | undefined;
  run: Runner<never>;
  provider: { parse(value: string): string };
  mcpServers: McpServers;
};

export function registerBotRequestRoutes(options: Options) {
  const { register, service, botRequests, run, provider, mcpServers } = options;

  if (!botRequests) return;

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

            const body = z
              .object({ proposal: agentInput.optional() })
              .parse(raw.trim() ? JSON.parse(raw) : {});

            const proposal = body.proposal ?? pending;

            provider.parse(proposal.provider);
            mcpServers.check(null, proposal.mcpServers, true);

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
