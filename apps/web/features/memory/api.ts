import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type { memoryResponse } from "@crumble/server/contract/api-responses";
import { agentPath } from "@/features/bots/api";
import { api, queryClient } from "@/lib/api";

export type Memory = z.infer<typeof memoryResponse>;

const memoriesKey = ["memories"];

export const botMemoriesQuery = (id: string) =>
  queryOptions({
    queryKey: [...memoriesKey, id],
    queryFn: ({ signal }) =>
      api<"agentMemories">(`${agentPath(id)}/memories`, { signal }),
  });

export const sharedMemoriesQuery = queryOptions({
  queryKey: [...memoriesKey, "shared"],
  queryFn: ({ signal }) => api<"memories">("/v1/memories", { signal }),
});

export const invalidateMemories = () =>
  queryClient.invalidateQueries({ queryKey: memoriesKey });
