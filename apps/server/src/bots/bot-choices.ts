import { McpServers } from "../integrations/mcp-servers";
import type { Runner } from "../shared/runner";

/** Fails unless the bot `owner` names (null for a new one) may use the provider and MCP servers of `input`. */
export async function checkBotChoices(
  options: {
    /** Accepts a provider ID only if this server can serve it. */
    provider: { parse(value: string): string };
    run: Runner<McpServers>;
  },
  input: { provider: string; mcpServers: readonly string[] },
  owner: string | null,
) {
  options.provider.parse(input.provider);
  await options.run.runPromise(
    McpServers.use((servers) =>
      owner === null
        ? servers.check(null, input.mcpServers, true)
        : servers.check(owner, input.mcpServers),
    ),
  );
}
