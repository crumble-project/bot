import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  judgeModelResponse,
  loginSessionResponse,
  modelResponse,
  pluginSettingsResponse,
  providerResponse,
  visionModelResponse,
} from "@crumble/server/contract/api-responses";
import type { serverSettingsSchema } from "@crumble/server/contract/admin";
import type {
  createdEventSourceResponse,
  eventSourceResponse,
  relayStatusResponse,
} from "@crumble/server/contract/event-sources";
import type {
  githubAccountResponse,
  githubAppManifestResponse,
  githubAppResponse,
} from "@crumble/server/contract/github-apps";
import type {
  gatewayConfigInput,
  gatewayResponse,
} from "@crumble/server/contract/message-gateway";
import { refreshAllCredentials } from "@/features/credentials/api";
import { api, queryClient } from "@/lib/api";
import { refreshSecrets } from "@/lib/secrets";

export type GatewayConfig = z.infer<typeof gatewayConfigInput>;

export type MessageGateway = z.infer<typeof gatewayResponse>;

export type RelayStatus = z.infer<typeof relayStatusResponse>;

export type EventSource = z.infer<typeof eventSourceResponse>;

export type CreatedEventSource = z.infer<typeof createdEventSourceResponse>;

export type Model = z.infer<typeof modelResponse>;

export type LoginSession = z.infer<typeof loginSessionResponse>;

export type Provider = z.infer<typeof providerResponse>;

export type GitHubApp = z.infer<typeof githubAppResponse>;

export type GitHubAccount = z.infer<typeof githubAccountResponse>;

export type GitHubAppManifest = z.infer<typeof githubAppManifestResponse>;

export type JudgeModel = z.infer<typeof judgeModelResponse>;

export type VisionModel = z.infer<typeof visionModelResponse>;

export type PluginSettings = z.infer<typeof pluginSettingsResponse>;

export type ServerSettings = z.infer<typeof serverSettingsSchema>;

export const serverSettingsQuery = queryOptions({
  queryKey: ["admin", "settings"],
  queryFn: () => api<"serverSettings">("/v1/admin/settings"),
});

export const refreshAdmin = () =>
  queryClient.invalidateQueries({ queryKey: ["admin"] });

const modelsKey = ["models"];

export const modelsQuery = (provider: string) =>
  queryOptions({
    queryKey: [...modelsKey, provider],
    queryFn: ({ signal }) =>
      api<"models">(`/v1/models?provider=${encodeURIComponent(provider)}`, {
        signal,
      }),
    staleTime: 5 * 60_000,
  });

export const providersQuery = queryOptions({
  queryKey: ["providers"],
  queryFn: ({ signal }) => api<"providers">("/v1/providers", { signal }),
});

export async function refreshProviders() {
  await queryClient.invalidateQueries({ queryKey: providersQuery.queryKey });
  await queryClient.invalidateQueries({ queryKey: modelsKey });
}

export const providerPath = (provider: string) =>
  `/v1/providers/${encodeURIComponent(provider)}` as const;

export const providerLoginPath = (id: string) =>
  `/v1/provider-logins/${encodeURIComponent(id)}` as const;

export const loginQuery = (id: string) =>
  queryOptions({
    queryKey: ["login", id],
    queryFn: ({ signal }) =>
      api<"getProviderLogin">(providerLoginPath(id), { signal }),
    // Sign-ins advance on the server, so poll until they end.
    refetchInterval: (query) =>
      query.state.data?.status === "pending" ? 1000 : false,
  });

export const judgeModelQuery = queryOptions({
  queryKey: ["judge-model"],
  queryFn: ({ signal }) => api<"getJudgeModel">("/v1/judge-model", { signal }),
});

export const visionModelQuery = queryOptions({
  queryKey: ["vision-model"],
  queryFn: ({ signal }) =>
    api<"getVisionModel">("/v1/vision-model", { signal }),
});

export const pluginSettingsQuery = queryOptions({
  queryKey: ["plugin-settings"],
  queryFn: ({ signal }) =>
    api<"pluginSettings">("/v1/plugin-settings", { signal }),
});

export const pluginSettingPath = (pluginId: string, key: string) =>
  `/v1/plugin-settings/${encodeURIComponent(pluginId)}/${encodeURIComponent(key)}` as const;

export const messageGatewaysQuery = queryOptions({
  queryKey: ["message-gateways"],
  queryFn: async ({ signal }) =>
    (await api<"messageGateways">("/v1/message-gateways", { signal })).gateways,
  refetchInterval: 5000,
});

export const messageGatewayPath = (id: string) =>
  `/v1/message-gateways/${encodeURIComponent(id)}` as const;

export const eventRelayQuery = queryOptions({
  queryKey: ["event-relay"],
  queryFn: ({ signal }) => api<"eventRelay">("/v1/event-relay", { signal }),
  // The connection advances on the server, so poll while it connects.
  refetchInterval: (query) =>
    query.state.data?.status === "connecting" ? 1000 : false,
});

export const eventSourcesQuery = queryOptions({
  queryKey: ["event-sources"],
  queryFn: async ({ signal }) =>
    (await api<"eventSources">("/v1/event-sources", { signal })).sources,
});

export const eventSourcePath = (id: string) =>
  `/v1/event-sources/${encodeURIComponent(id)}` as const;

export const githubAppPath = (id: string) =>
  `/v1/github-apps/${encodeURIComponent(id)}` as const;

export const githubAppsQuery = queryOptions({
  queryKey: ["github-apps"],
  queryFn: async ({ signal }) =>
    (await api<"githubApps">("/v1/github-apps", { signal })).apps,
});

export const githubAccountPath = (id: string) =>
  `/v1/github-accounts/${encodeURIComponent(id)}` as const;

export const githubAccountsQuery = queryOptions({
  queryKey: ["github-accounts"],
  queryFn: async ({ signal }) =>
    (await api<"githubAccounts">("/v1/github-accounts", { signal })).accounts,
});

/** A bot's GH_TOKEN appears or goes with its Apps and machine account, so credentials refresh too. */
export const refreshGithub = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: githubAppsQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: githubAccountsQuery.queryKey }),
    refreshAllCredentials(),
    refreshSecrets(),
  ]).then(() => undefined);
