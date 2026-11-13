import { Context, Effect } from "effect";
import type { Env } from "hono";
import { botRequestApproval, routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { pi } from "../shared/app-errors";
import type { BotLookup } from "../bot-ports/bot-lookup";
import { checkBotChoices } from "../bots/bot-choices";
import { McpServers } from "../integrations/mcp-servers";
import { BotRequests } from "./bot-requests";

type Options = {
  register: Register<Env, BotRequests | McpServers>;
  service: BotLookup;
  provider: { parse(value: string): string };
};

export function registerBotRequestRoutes(options: Options) {
  const { register, service, provider } = options;

  register(routes.listBotRequests, function* (c) {
    service.agent(c.req.param("id"));
    const botRequests = yield* BotRequests;

    return c.json(yield* botRequests.list(c.req.param("id")), 200);
  });
  register(routes.approveBotRequest, function* (c) {
    const agentId = c.req.param("id");

    service.agent(agentId);
    const botRequests = yield* BotRequests;
    const mcpServers = yield* McpServers;
    const context = Context.make(McpServers, mcpServers);

    return c.json(
      yield* botRequests.approve(agentId, c.req.param("requestId"), (pending) =>
        pi(async () => {
          const raw = await c.req.text();

          const body = botRequestApproval.parse(
            raw.trim() ? JSON.parse(raw) : {},
          );

          const proposal = body.proposal ?? pending;

          await Effect.runPromiseWith(context)(
            checkBotChoices(provider, proposal, null),
          );

          return proposal;
        }),
      ),
      200,
    );
  });
  register(routes.declineBotRequest, function* (c) {
    service.agent(c.req.param("id"));
    const botRequests = yield* BotRequests;

    return c.json(
      yield* botRequests.decline(c.req.param("id"), c.req.param("requestId")),
      200,
    );
  });
}
