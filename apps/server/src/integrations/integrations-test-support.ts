import { Context, Effect, Layer, ManagedRuntime, Scope } from "effect";
import type { AgentRepository } from "../bot-store/agent-repository";
import type { BotDeletion } from "../bot-ports/bot-deletion";
import type { Secrets } from "../secrets/secrets";
import type { ServerSecrets } from "../secrets/server-secrets";
import type { Runner } from "../shared/runner";
import { McpIntegrations, type IntegrationsOptions } from "./integrations";
import type { McpServerRepository } from "./mcp-server-repository";
import { McpServers } from "./mcp-servers";

type IntegrationServices =
  | McpServerRepository
  | AgentRepository
  | ServerSecrets
  | Secrets;

/** MCP integrations over the data `core` reaches, for a test that runs without an account. */
export function standaloneIntegrations(
  core: Runner<IntegrationServices>,
  options: IntegrationsOptions = {},
) {
  const runtime = ManagedRuntime.make(
    McpIntegrations.layer(options).pipe(
      Layer.provide(
        Layer.succeedContext(
          core.runSync(Effect.context<IntegrationServices>()),
        ),
      ),
    ),
  );

  return {
    integrations: runtime.runSync(McpIntegrations.use(Effect.succeed)),
    close: () => runtime.dispose(),
  };
}

/** `McpServers` over `integrations` and what `context` holds, for an API test; it lives as long as the test. */
export const mcpServersOver = (
  context: Context.Context<IntegrationServices | BotDeletion>,
  integrations: McpIntegrations["Service"],
) =>
  Context.get(
    Effect.runSync(
      Layer.buildWithScope(
        McpServers.layer.pipe(
          Layer.provide(Layer.succeed(McpIntegrations, integrations)),
          Layer.provide(Layer.succeedContext(context)),
        ),
        Scope.makeUnsafe(),
      ),
    ),
    McpServers,
  );
