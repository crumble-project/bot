import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  chatSnapshotResponse,
  historyResponse,
} from "@crumble/server/contract/api-responses";
import { agentPath } from "@/features/bots/api";
import { api } from "@/lib/api";

export type ChatSnapshot = z.infer<typeof chatSnapshotResponse>;

export type HistoryPage = z.infer<typeof historyResponse>;

export type Message = HistoryPage["messages"][number];

export const CHAT_KEY = "chat";

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
