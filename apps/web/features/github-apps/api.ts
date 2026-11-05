import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  githubAccountResponse,
  githubAppManifestResponse,
  githubAppResponse,
} from "@crumble/server/contract/github-apps";
import { refreshAllCredentials } from "@/features/credentials/api";
import { refreshSecrets } from "@/features/password-managers/api";
import { api, queryClient } from "@/lib/api";

export type GitHubApp = z.infer<typeof githubAppResponse>;

export type GitHubAccount = z.infer<typeof githubAccountResponse>;

export type GitHubAppManifest = z.infer<typeof githubAppManifestResponse>;

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
