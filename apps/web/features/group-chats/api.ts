import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  groupChatResponse,
  groupChatSnapshotResponse,
} from "@crumble/server/contract/api-responses";
import { api, queryClient } from "@/lib/api";

export type GroupChat = z.infer<typeof groupChatResponse>;

export type GroupChatSnapshot = z.infer<typeof groupChatSnapshotResponse>;

export const membersOf = <B>(memberIds: string[], byId: Map<string, B>) =>
  memberIds.flatMap((id) => {
    const bot = byId.get(id);

    return bot ? [bot] : [];
  });

export const groupPath = (id: string) =>
  `/v1/group-chats/${encodeURIComponent(id)}` as const;

export const groupsQuery = queryOptions({
  queryKey: ["groups"],
  queryFn: ({ signal }) => api<"listGroupChats">("/v1/group-chats", { signal }),
});

export const invalidateGroups = () =>
  queryClient.invalidateQueries({ queryKey: groupsQuery.queryKey });

export const groupChatQuery = (id: string) =>
  queryOptions({
    queryKey: ["group-chat", id],
    queryFn: ({ signal }) =>
      api<"groupChatSnapshot">(`${groupPath(id)}/chat`, { signal }),
  });
