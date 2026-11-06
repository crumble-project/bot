import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  eventSourceResponse,
  relayStatusResponse,
} from "@crumble/server/contract/event-sources";
import { api } from "@/lib/api";

export type RelayStatus = z.infer<typeof relayStatusResponse>;

export type EventSource = z.infer<typeof eventSourceResponse>;

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
