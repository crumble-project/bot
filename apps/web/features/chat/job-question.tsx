import { useQuery } from "@tanstack/react-query";
import { IconMessageQuestion } from "@tabler/icons-react";
import { JobQuestionAnswer } from "@/features/jobs/job-question-answer";
import { jobsQuery } from "@/lib/api";
import { SettledCard } from "./transcript";

const PENDING_POLL_MS = 5000;

/** A coding job's question in the chat: an answer box while the job waits on it, then a settled card. */
export function JobQuestionCard({
  botId,
  question,
  text,
}: {
  botId: string;
  question: { id: string; job: string };
  text: string;
}) {
  const jobs = useQuery({
    ...jobsQuery(botId, "coding"),
    refetchOnMount: "always",
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.question?.id === question.id)
        ? PENDING_POLL_MS
        : false,
  });

  const waiting = jobs.data?.find(
    (job) => job.question?.id === question.id,
  )?.question;

  if (waiting)
    return (
      <JobQuestionAnswer botId={botId} job={question.job} question={waiting} />
    );

  return (
    <SettledCard
      icon={IconMessageQuestion}
      title={text}
      outcome={jobs.isFetchedAfterMount ? "Answered" : "Loading…"}
    />
  );
}
