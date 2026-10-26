import type { JsonValue } from "@earendil-works/chord";
import type { Credential, CredentialInfo } from "@earendil-works/pi-ai";
import {
  AgentCredentialRepository,
  type CredentialAuthority,
} from "../../src/credentials/agent-credential-repository";
import { SecretRepository } from "../../src/credentials/secret-repository";
import {
  McpServerRepository,
  type NewMCPServer,
} from "../../src/integrations/mcp-server-repository";
import { ProviderCredentialRepository } from "../../src/providers/provider-credential-repository";
import type {
  AgentCredential,
  CredentialGrant,
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
  deleteSetting: (key: string) => {
    return run(SettingsRepository.use((r) => r.delete(key)));
  },
  listSettings: (): Record<string, JsonValue> => {
    return run(SettingsRepository.use((r) => r.list));
  },

  setCredential: (key: string, value: string) => {
    run(SecretRepository.use((r) => r.set(key, value)));
  },
  getCredential: (key: string) => {
    return run(SecretRepository.use((r) => r.get(key)));
  },
  deleteCredential: (key: string) => {
    return run(SecretRepository.use((r) => r.delete(key)));
  },
  listCredentials: () => {
    return run(SecretRepository.use((r) => r.listKeys));
  },

  /** Metadata only: listing never decrypts a value. */
  listAgentCredentials: (agentId: string): AgentCredential[] => {
    return run(AgentCredentialRepository.use((r) => r.list(agentId)));
  },
  getAgentCredential: (agentId: string, name: string) => {
    return run(AgentCredentialRepository.use((r) => r.get(agentId, name)));
  },
  /** Creating needs a value; updating keeps the stored one when `value` is omitted. The placeholder never changes. */
  saveAgentCredential: (
    agentId: string,
    name: string,
    input: { hosts: string[]; value?: string | undefined; placeholder: string },
  ) => {
    return run(
      AgentCredentialRepository.use((r) => r.save(agentId, name, input)),
    );
  },
  deleteAgentCredential: (agentId: string, name: string) => {
    return run(AgentCredentialRepository.use((r) => r.delete(agentId, name)));
  },
  /** Each credential's placeholder by name, for the bot's job environments. */
  agentCredentialPlaceholders: (agentId: string): Record<string, string> => {
    return run(AgentCredentialRepository.use((r) => r.placeholders(agentId)));
  },
  /** Every credential with its placeholder and decrypted value, for the credential proxy only. */
  agentCredentialGrants: (agentId: string): CredentialGrant[] => {
    return run(AgentCredentialRepository.use((r) => r.grants(agentId)));
  },
  getCredentialAuthority: (agentId: string) => {
    return run(AgentCredentialRepository.use((r) => r.getAuthority(agentId)));
  },
  saveCredentialAuthority: (
    agentId: string,
    authority: CredentialAuthority,
  ) => {
    return run(
      AgentCredentialRepository.use((r) => r.saveAuthority(agentId, authority)),
    );
  },
  listCredentialRequests: (agentId: string): CredentialRequest[] => {
    return run(AgentCredentialRepository.use((r) => r.listRequests(agentId)));
  },
  getCredentialRequest: (agentId: string, name: string) => {
    return run(
      AgentCredentialRepository.use((r) => r.getRequest(agentId, name)),
    );
  },
  setCredentialRequest: (
    agentId: string,
    request: { name: string; hosts: string[]; reason: string },
  ) => {
    return run(
      AgentCredentialRepository.use((r) => r.setRequest(agentId, request)),
    );
  },
  deleteCredentialRequest: (agentId: string, name: string) => {
    return run(
      AgentCredentialRepository.use((r) => r.deleteRequest(agentId, name)),
    );
  },
  addCredentialUse: (
    agentId: string,
    name: string,
    use: Omit<CredentialUse, "id">,
  ) => {
    run(AgentCredentialRepository.use((r) => r.addUse(agentId, name, use)));
  },
  /** Newest first; page with `before` set to the last use's ID. */
  listCredentialUses: (
    agentId: string,
    name: string,
    options: { limit: number; before?: string | undefined },
  ): CredentialUse[] => {
    return run(
      AgentCredentialRepository.use((r) => r.listUses(agentId, name, options)),
    );
  },
  pruneCredentialUses: (olderThan: string) => {
    run(AgentCredentialRepository.use((r) => r.pruneUses(olderThan)));
  },

  getProviderCredential: (providerId: string): Credential | undefined => {
    return run(ProviderCredentialRepository.use((r) => r.get(providerId)));
  },
  setProviderCredential: (providerId: string, credential: Credential) => {
    run(ProviderCredentialRepository.use((r) => r.set(providerId, credential)));
  },
  deleteProviderCredential: (providerId: string) => {
    return run(ProviderCredentialRepository.use((r) => r.delete(providerId)));
  },
  /** Metadata only: listing never decrypts a credential. */
  listProviderCredentials: (): CredentialInfo[] => {
    return run(ProviderCredentialRepository.use((r) => r.list));
  },
  /** Moves API keys saved before typed credentials into the provider table; MCP keys never match a provider ID. */
  migrateProviderCredentials: (providerIds: readonly string[]) => {
    run(ProviderCredentialRepository.use((r) => r.migrateApiKeys(providerIds)));
  },

  listMCPServers: (): MCPServer[] => {
    return run(McpServerRepository.use((r) => r.list));
  },
  getMCPServer: (serverId: string) => {
    return run(McpServerRepository.use((r) => r.get(serverId)));
  },
  /** A server the bot may use: enabled, and shared or its own. */
  usableMCPServer: (agentId: string, serverId: string) => {
    return run(McpServerRepository.use((r) => r.usable(agentId, serverId)));
  },
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
