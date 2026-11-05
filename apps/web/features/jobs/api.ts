import { queryOptions, useQuery } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type { codingJobsResponse } from "@crumble/server/contract/api-responses";
import { agentPath } from "@/features/bots/api";
import { api, queryClient } from "@/lib/api";
import type { JobKind } from "@/lib/job-kinds";

export type CodingJob = z.infer<typeof codingJobsResponse>["jobs"][number];

type JobsRoute = "codingJobs" | "desktopJobs";

const ACTIVE_REFRESH_MS = 3_000;
const IDLE_REFRESH_MS = 15_000;

export const jobsQuery = (id: string, kind: JobKind) =>
  queryOptions({
    queryKey: ["jobs", id, kind],
    queryFn: async ({ signal }) =>
      // Coding and desktop jobs share one response shape.
      (await api<JobsRoute>(`${agentPath(id)}/${kind}-jobs`, { signal })).jobs,
    refetchOnMount: "always",
    // A job's own progress sends the chat nothing, and a chat message may never tell of a job waking up.
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === "working" || job.question)
        ? ACTIVE_REFRESH_MS
        : IDLE_REFRESH_MS,
  });

/** A bot's jobs of one kind, for everything that shows them. */
export const useJobs = (id: string, kind: JobKind, enabled = true) =>
  useQuery({ ...jobsQuery(id, kind), enabled });

export const refreshJobs = (id: string, kind: JobKind) =>
  queryClient.invalidateQueries({ queryKey: jobsQuery(id, kind).queryKey });

export const jobPath = <K extends JobKind>(id: string, kind: K, name: string) =>
  `${agentPath(id)}/${kind}-jobs/${encodeURIComponent(name)}` as const;
