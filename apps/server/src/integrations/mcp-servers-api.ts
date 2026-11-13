import { Effect } from "effect";
import type { Env } from "hono";
import { routes, mcpInput } from "../contract/api-contract";
import { mergedBody, type Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import { McpServers } from "./mcp-servers";

type McpServerRoutesOptions = {
  register: Register<Env, McpServers>;
  service: BotLookup;
};

const registerMcpAuthRoutes = ({ register }: McpServerRoutesOptions) => {
  register(routes.mcpServers, function* (c) {
    const servers = yield* McpServers;

    return c.json(yield* servers.list, 200);
  });
  register(routes.oauth, function* (c) {
    const { redirectUri } = c.req.valid("json");
    const servers = yield* McpServers;

    return c.json(
      yield* servers.startSignIn(c.req.param("id"), redirectUri),
      200,
    );
  });
  register(routes.oauthCallback, function* (c) {
    const servers = yield* McpServers;

    return c.json(
      yield* servers.finishSignIn(c.req.param("id"), c.req.valid("json")),
      200,
    );
  });
  register(routes.deleteOauth, function* (c) {
    const servers = yield* McpServers;

    return c.json(yield* servers.signOut(c.req.param("id")), 200);
  });
};

const registerMcpServerEditRoutes = (options: McpServerRoutesOptions) => {
  const { register, service } = options;

  register(routes.createMcpServer, function* (c) {
    const input = c.req.valid("json");
    const owner = input.agentId ? service.agent(input.agentId) : null;
    const servers = yield* McpServers;

    return c.json(yield* servers.create(input, owner), 201);
  });
  register(
    routes.updateMcpServer,
    function* (c) {
      const servers = yield* McpServers;
      const old = yield* servers.get(c.req.param("id"));

      const input = yield* Effect.promise(() => mergedBody(c, old, mcpInput));

      return c.json(yield* servers.update(old, input), 200);
    },
    { parsesBody: true },
  );
  register(routes.deleteMcpServer, function* (c) {
    const servers = yield* McpServers;

    yield* servers.delete(c.req.param("id"));

    return c.body(null, 204);
  });
};

export function registerMcpServerRoutes(options: McpServerRoutesOptions) {
  registerMcpAuthRoutes(options);
  registerMcpServerEditRoutes(options);
}
