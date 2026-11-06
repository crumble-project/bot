import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type { BotInput } from "@crumble/server/contract/api-contract";
import type {
  agentPreviewResponse,
  capabilitiesResponse,
} from "@crumble/server/contract/api-responses";
import { api, queryClient } from "@/lib/api";

export type Bot = z.infer<typeof agentPreviewResponse>;

export type { BotInput };

export type Capabilities = z.infer<typeof capabilitiesResponse>;

export const agentPath = (id: string) =>
  `/v1/agents/${encodeURIComponent(id)}` as const;

export const botsQuery = queryOptions({
  queryKey: ["bots"],
  queryFn: ({ signal }) => api<"listAgents">("/v1/agents", { signal }),
});

export const invalidateBots = () =>
  queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });

export const capabilitiesQuery = queryOptions({
  queryKey: ["capabilities"],
  queryFn: ({ signal }) => api<"capabilities">("/v1/capabilities", { signal }),
  staleTime: Infinity,
});
