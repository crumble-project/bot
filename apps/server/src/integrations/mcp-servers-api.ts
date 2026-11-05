import { routes, mcpInput } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotsAccess } from "../bots/bots";
import type { McpServers } from "./mcp-servers";

type McpServerRoutesOptions = {
  register: Register;
  service: BotsAccess;
  mcpServers: McpServers;
};

/** The account's MCP servers, and the OAuth sign-in flow for the ones that need it. */
const registerMcpAuthRoutes = (options: McpServerRoutesOptions) => {
  const { register, mcpServers } = options;

  register(routes.mcpServers, (c) => c.json(mcpServers.list(), 200));
  // OAuth sign-in: the client opens the returned URL, then posts back the code, state and issuer it receives.
  register(routes.oauth, async (c) => {
    const { redirectUri } = c.req.valid("json");

    return c.json(
      await mcpServers.startSignIn(c.req.param("id"), redirectUri),
      200,
    );
  });
  register(routes.oauthCallback, async (c) => {
    return c.json(
      await mcpServers.finishSignIn(c.req.param("id"), c.req.valid("json")),
      200,
    );
  });
  register(routes.deleteOauth, async (c) =>
    c.json(await mcpServers.signOut(c.req.param("id")), 200),
  );
};

/** Adding, editing, and deleting MCP servers. */
const registerMcpServerEditRoutes = (options: McpServerRoutesOptions) => {
  const { register, service, mcpServers } = options;

  register(routes.createMcpServer, async (c) => {
    const input = c.req.valid("json");
    const owner = input.agentId ? service.agent(input.agentId) : null;

    return c.json(await mcpServers.create(input, owner), 201);
  });
  register(
    routes.updateMcpServer,
    async (c) => {
      const old = mcpServers.get(c.req.param("id"));
      const input = mcpInput.parse({ ...old, ...(await c.req.json()) });

      return c.json(await mcpServers.update(old, input), 200);
    },
    { parsesBody: true },
  );
  register(routes.deleteMcpServer, async (c) => {
    await mcpServers.delete(c.req.param("id"));

    return c.body(null, 204);
  });
};

/** The MCP server routes, in the order the contract document lists them. */
export function registerMcpServerRoutes(options: McpServerRoutesOptions) {
  registerMcpAuthRoutes(options);
  registerMcpServerEditRoutes(options);
}
