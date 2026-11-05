import { McpServers } from "../integrations/mcp-servers";
import type { Runner } from "../shared/runner";

export async function checkBotChoices(
  options: {
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
