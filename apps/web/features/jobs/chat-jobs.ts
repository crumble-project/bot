import { useEffect, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Message } from "@/features/chat/api";
import { JOB_KIND_NAMES, isJobKind } from "@crumble/server/contract/tools";
import { type JobRef, jobsQuery, invalidateJobs } from "./api";
import { jobOf } from "./job-card";

export function useChatJobs(botId: string, messages: Message[]) {
  const jobs = messages.flatMap((message) => jobOf(message) ?? []);
  const kinds = new Set(jobs.map((job) => job.kind));

  const lists = useQueries({
    queries: JOB_KIND_NAMES.map((kind) => ({
      ...jobsQuery(botId, kind),
      enabled: kinds.has(kind),
    })),
  });

  const jobMessages =
    jobs.length +
    messages.filter((message) => isJobKind(message.origin?.kind)).length;

  const counted = useRef(jobMessages);

  useEffect(() => {
    if (counted.current === jobMessages) return;
    counted.current = jobMessages;

    for (const kind of JOB_KIND_NAMES) void invalidateJobs(botId, kind);
  }, [botId, jobMessages]);

  return ({ kind, name }: JobRef) =>
    lists[JOB_KIND_NAMES.indexOf(kind)]?.data?.find(
      (each) => each.name === name,
    )?.status;
}
