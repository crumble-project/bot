import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  judgeModelResponse,
  loginSessionResponse,
  modelResponse,
  providerResponse,
  visionModelResponse,
} from "@crumble/server/contract/api-responses";
import { api, queryClient } from "@/lib/api";

export type Model = z.infer<typeof modelResponse>;

export type ProviderSignIn = z.infer<typeof loginSessionResponse>;

export type Provider = z.infer<typeof providerResponse>;

export type JudgeModel = z.infer<typeof judgeModelResponse>;

export type VisionModel = z.infer<typeof visionModelResponse>;

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

export const providerSignInPath = (id: string) =>
  `/v1/provider-logins/${encodeURIComponent(id)}` as const;

export const signInQuery = (id: string) =>
  queryOptions({
    queryKey: ["provider-sign-in", id],
    queryFn: ({ signal }) =>
      api<"getProviderLogin">(providerSignInPath(id), { signal }),
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
