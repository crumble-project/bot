import type { JsonValue } from "@earendil-works/chord";
import { Effect } from "effect";
import { BotSecretRequests } from "../../src/bot-secrets/bot-secret-requests";
import { AgentCredentialRepository } from "../../src/credentials/agent-credential-repository";
import { Credentials } from "../../src/credentials/credentials";
import { SecretRepository } from "../../src/credentials/secret-repository";
import {
  McpServerRepository,
  type NewMCPServer,
} from "../../src/integrations/mcp-server-repository";
import type {
  CredentialRequest,
  CredentialUse,
  MCPServer,
} from "../../src/shared/domain";
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

  /** Metadata only: listing never decrypts a value. */
  /** Creating needs a value; updating keeps the stored one when `value` is omitted. The placeholder never changes. */
  /** Each credential's placeholder by name, for the bot's job environments. */
  agentCredentialPlaceholders: (agentId: string): Record<string, string> => {
    return run(AgentCredentialRepository.use((r) => r.placeholders(agentId)));
  },
  /** Every credential with its placeholder and decrypted value, for the credential proxy only. */
  listCredentialRequests: (agentId: string): CredentialRequest[] => {
    return run(BotSecretRequests.use((r) => r.list(agentId, "credential")));
  },
  /** Newest first; page with `before` set to the last use's ID. */
  listCredentialUses: (
    agentId: string,
    name: string,
    options: { limit: number; before?: string | undefined },
  ): CredentialUse[] => {
    return run(
      Credentials.use((c) => c.uses(agentId, name, options)).pipe(Effect.orDie),
    );
  },
  /** Metadata only: listing never decrypts a credential. */
  /** Moves API keys saved before typed credentials into the provider table; MCP keys never match a provider ID. */
  /** A server the bot may use: enabled, and shared or its own. */
  createMCPServer: (input: NewMCPServer, serverId?: string): MCPServer => {
    return run(McpServerRepository.use((r) => r.create(input, serverId)));
  },
  /** Changes a server's settings; which bot it belongs to is fixed at creation. */
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
