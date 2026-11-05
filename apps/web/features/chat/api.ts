import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  chatSnapshotResponse,
  heldActionResponse,
  historyResponse,
} from "@crumble/server/contract/api-responses";
import { agentPath } from "@/features/bots/api";
import { api } from "@/lib/api";

export type ChatSnapshot = z.infer<typeof chatSnapshotResponse>;

export type HistoryPage = z.infer<typeof historyResponse>;

export type Message = HistoryPage["messages"][number];

export type HeldAction = z.infer<typeof heldActionResponse>;

export const CHAT_KEY = "chat";

const HELD_POLL_MS = 5000;

/** The URL of one page of a transcript at `path`. */
export const historyPage = <P extends string>(
  path: P,
  limit: number,
  before?: string | null,
) =>
  `${path}?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}` as const;

export const chatQuery = (id: string) =>
  queryOptions({
    queryKey: [CHAT_KEY, id],
    queryFn: ({ signal }) => api<"chat">(`${agentPath(id)}/chat`, { signal }),
  });

export const heldActionsQuery = (id: string) =>
  queryOptions({
    queryKey: ["held-actions", id],
    queryFn: ({ signal }) =>
      api<"agentHeldActions">(`${agentPath(id)}/held-actions`, { signal }),
    // A stopped job, a restart, or another client can end a waiting action.
    refetchInterval: (query) =>
      query.state.data?.some((action) => action.status === "pending")
        ? HELD_POLL_MS
        : false,
  });

export const heldActionPath = (id: string, actionId: string) =>
  `${agentPath(id)}/held-actions/${encodeURIComponent(actionId)}` as const;
