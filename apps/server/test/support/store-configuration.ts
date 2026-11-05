import type { JsonValue } from "@earendil-works/chord";
import { Effect } from "effect";
import { BotSecretRequests } from "../../src/bot-secrets/bot-secret-requests";
import { AgentCredentialRepository } from "../../src/credentials/agent-credential-repository";
import { Credentials } from "../../src/credentials/credentials";
import { SecretRepository } from "../../src/secrets/secret-repository";
import {
  McpServerRepository,
  type NewMCPServer,
} from "../../src/integrations/mcp-server-repository";
import type {
  CredentialRequest,
  CredentialUse,
} from "../../src/credentials/agent-credential-repository";
import type { MCPServer } from "../../src/integrations/mcp-server-repository";
import { SettingsRepository } from "../../src/shared/settings-repository";
import type { StoreRun } from "./store";

export const configurationStore = (run: StoreRun) => ({
  getSetting: <T = unknown>(key: string): T | undefined => {
    // SAFETY: callers read a setting as the type they stored under the same key.
    return run(SettingsRepository.use((r) => r.get(key))) as T | undefined;
  },
  setSetting: <T extends JsonValue>(key: string, value: T) => {
    run(SettingsRepository.use((r) => r.set(key, value)));

    return value;
  },
  setCredential: (key: string, value: string) => {
    run(SecretRepository.use((r) => r.set(key, value)));
  },
  getCredential: (key: string) => {
    return run(SecretRepository.use((r) => r.get(key)));
  },

  agentCredentialPlaceholders: (agentId: string): Record<string, string> => {
    return run(AgentCredentialRepository.use((r) => r.placeholders(agentId)));
  },
  listCredentialRequests: (agentId: string): CredentialRequest[] => {
    return run(BotSecretRequests.use((r) => r.list(agentId, "credential")));
  },
  listCredentialUses: (
    agentId: string,
    name: string,
    options: { limit: number; before?: string | undefined },
  ): CredentialUse[] => {
    return run(
      Credentials.use((c) => c.uses(agentId, name, options)).pipe(Effect.orDie),
    );
  },
  createMCPServer: (input: NewMCPServer, serverId?: string): MCPServer => {
    return run(McpServerRepository.use((r) => r.create(input, serverId)));
  },
  updateMCPServer: (
    serverId: string,
    patch: Partial<Omit<MCPServer, "id" | "agentId">>,
  ) => {
    return run(McpServerRepository.use((r) => r.update(serverId, patch)));
  },
  deleteMCPServer: (serverId: string) => {
    return run(McpServerRepository.use((r) => r.delete(serverId)));
  },
});
