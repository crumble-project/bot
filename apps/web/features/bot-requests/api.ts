import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type { botRequestResponse } from "@crumble/server/contract/api-responses";
import { agentPath } from "@/features/bots/api";
import { api } from "@/lib/api";

export type BotRequest = z.infer<typeof botRequestResponse>;

export const botRequestsQuery = (id: string) =>
  queryOptions({
    queryKey: ["bot-requests", id],
    queryFn: ({ signal }) =>
      api<"listBotRequests">(`${agentPath(id)}/bot-requests`, { signal }),
  });

export const botRequestPath = (id: string, requestId: string) =>
  `${agentPath(id)}/bot-requests/${encodeURIComponent(requestId)}` as const;
