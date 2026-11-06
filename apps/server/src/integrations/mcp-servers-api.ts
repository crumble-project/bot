import { routes, mcpInput } from "../contract/api-contract";
import { mergedBody, type Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import type { Runner } from "../shared/runner";
import { McpServers } from "./mcp-servers";

type McpServerRoutesOptions = {
  register: Register;
  service: BotLookup;
  run: Runner<McpServers>;
};

const registerMcpAuthRoutes = ({ register, run }: McpServerRoutesOptions) => {
  register(routes.mcpServers, async (c) =>
    c.json(await run.runPromise(McpServers.use((s) => s.list)), 200),
  );
  register(routes.oauth, async (c) => {
    const { redirectUri } = c.req.valid("json");

    return c.json(
      await run.runPromise(
        McpServers.use((s) => s.startSignIn(c.req.param("id"), redirectUri)),
      ),
      200,
    );
  });
  register(routes.oauthCallback, async (c) => {
    return c.json(
      await run.runPromise(
        McpServers.use((s) =>
          s.finishSignIn(c.req.param("id"), c.req.valid("json")),
        ),
      ),
      200,
    );
  });
  register(routes.deleteOauth, async (c) =>
    c.json(
      await run.runPromise(McpServers.use((s) => s.signOut(c.req.param("id")))),
      200,
    ),
  );
};

const registerMcpServerEditRoutes = (options: McpServerRoutesOptions) => {
  const { register, service, run } = options;

  register(routes.createMcpServer, async (c) => {
    const input = c.req.valid("json");
    const owner = input.agentId ? service.agent(input.agentId) : null;

    return c.json(
      await run.runPromise(McpServers.use((s) => s.create(input, owner))),
      201,
    );
  });
  register(
    routes.updateMcpServer,
    async (c) => {
      const old = await run.runPromise(
        McpServers.use((s) => s.get(c.req.param("id"))),
      );

      const input = await mergedBody(c, old, mcpInput);

      return c.json(
        await run.runPromise(McpServers.use((s) => s.update(old, input))),
        200,
      );
    },
    { parsesBody: true },
  );
  register(routes.deleteMcpServer, async (c) => {
    await run.runPromise(McpServers.use((s) => s.delete(c.req.param("id"))));

    return c.body(null, 204);
  });
};

export function registerMcpServerRoutes(options: McpServerRoutesOptions) {
  registerMcpAuthRoutes(options);
  registerMcpServerEditRoutes(options);
}
