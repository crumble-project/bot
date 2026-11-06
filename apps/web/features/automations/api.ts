import { mutationOptions, queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  executionResponse,
  scheduleResponse,
  scriptRunResponse,
} from "@crumble/server/contract/api-responses";
import { api, queryClient, send } from "@/lib/api";

export type Schedule = z.infer<typeof scheduleResponse>;

export type ScriptRun = z.infer<typeof scriptRunResponse>;

export type Execution = z.infer<typeof executionResponse>;

export const schedulePath = (id: string) =>
  `/v1/schedules/${encodeURIComponent(id)}` as const;

export const schedulesQuery = queryOptions({
  queryKey: ["schedules"],
  queryFn: ({ signal }) => api<"schedules">("/v1/schedules", { signal }),
});

export const invalidateSchedules = () =>
  queryClient.invalidateQueries({ queryKey: schedulesQuery.queryKey });

export const toggleScheduleOptions = (id: string) =>
  mutationOptions({
    mutationFn: (enabled: boolean) =>
      send<"updateSchedule">(schedulePath(id), "PATCH", { enabled }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: schedulesQuery.queryKey });
      const previous = queryClient.getQueryData(schedulesQuery.queryKey);

      queryClient.setQueryData(schedulesQuery.queryKey, (list?: Schedule[]) =>
        list?.map((each) => (each.id === id ? { ...each, enabled } : each)),
      );

      return previous;
    },
    onError: (_error, _enabled, previous) =>
      queryClient.setQueryData(schedulesQuery.queryKey, previous),
    onSettled: () => invalidateSchedules(),
  });

export const executionsQuery = queryOptions({
  queryKey: ["executions"],
  queryFn: ({ signal }) => api<"executions">("/v1/executions", { signal }),
});

export const scriptRunsQuery = (id: string) =>
  queryOptions({
    queryKey: ["script-runs", id],
    queryFn: ({ signal }) =>
      api<"listScriptRuns">(`${schedulePath(id)}/runs?limit=20`, { signal }),
  });
