import type { JsonValue } from "@earendil-works/chord";
import { Effect } from "effect";
import { BotSecretRequests } from "../../src/bot-secrets/bot-secret-requests";
import { AgentCredentialRepository } from "../../src/credentials/agent-credential-repository";
import { Credentials } from "../../src/credentials/credentials";
import { SecretRepository } from "../../src/secrets/secret-repository";
import { McpServerRepository } from "../../src/integrations/mcp-server-repository";
import type { NewMCPServer } from "../../src/integrations/mcp-server-repository";
import type {
  CredentialRequest,
  CredentialUse,
} from "../../src/credentials/agent-credential-repository";
import type { MCPServer } from "../../src/integrations/mcp-server-repository";
import { SettingsRepository } from "../../src/shared/settings-repository";
import type { StoreRun } from "./store";

export const configurationStore = (run: StoreRun) => ({
  getSetting: (key: string): JsonValue | undefined =>
    run(Effect.flatMap(SettingsRepository, (r) => r.get(key))),
  setSetting: <T extends JsonValue>(key: string, value: T) => {
    run(Effect.flatMap(SettingsRepository, (r) => r.set(key, value)));

    return value;
  },
  setCredential: (key: string, value: string) => {
    run(Effect.flatMap(SecretRepository, (r) => r.set(key, value)));
  },
  getCredential: (key: string) => {
    return run(Effect.flatMap(SecretRepository, (r) => r.get(key)));
  },

  agentCredentialPlaceholders: (agentId: string): Record<string, string> => {
    return run(
      Effect.flatMap(AgentCredentialRepository, (r) => r.placeholders(agentId)),
    );
  },
  listCredentialRequests: (agentId: string): Array<CredentialRequest> => {
    return run(
      Effect.flatMap(BotSecretRequests, (r) => r.list(agentId, "credential")),
    );
  },
  listCredentialUses: (
    agentId: string,
    name: string,
    options: { limit: number; before?: string | undefined },
  ): Array<CredentialUse> => {
    return run(
      Effect.flatMap(Credentials, (c) => c.uses(agentId, name, options)).pipe(
        Effect.orDie,
      ),
    );
  },
  createMCPServer: (input: NewMCPServer, serverId?: string): MCPServer => {
    return run(
      Effect.flatMap(McpServerRepository, (r) => r.create(input, serverId)),
    );
  },
  updateMCPServer: (
    serverId: string,
    patch: Partial<Omit<MCPServer, "id" | "agentId">>,
  ) => {
    return run(
      Effect.flatMap(McpServerRepository, (r) => r.update(serverId, patch)),
    );
  },
  deleteMCPServer: (serverId: string) => {
    return run(Effect.flatMap(McpServerRepository, (r) => r.delete(serverId)));
  },
});
