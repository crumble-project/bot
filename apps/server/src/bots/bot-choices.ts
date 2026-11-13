import { Effect } from "effect";
import { McpServers } from "../integrations/mcp-servers";

export const checkBotChoices = Effect.fnUntraced(function* (
  provider: { parse(value: string): string },
  input: { provider: string; mcpServers: readonly string[] },
  owner: string | null,
) {
  provider.parse(input.provider);
  const servers = yield* McpServers;

  yield* owner === null
    ? servers.check(null, input.mcpServers, true)
    : servers.check(owner, input.mcpServers);
});
