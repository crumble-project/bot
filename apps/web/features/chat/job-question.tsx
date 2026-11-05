import { IconMessageQuestion } from "@tabler/icons-react";
import { SettledCard, useFreshRequest } from "@/components/request-card";
import { JobQuestionAnswer } from "@/features/jobs/job-question-answer";
import { type CodingJob, jobsQuery } from "@/features/jobs/api";

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
  const waitingIn = (jobs: CodingJob[]) =>
    jobs.find((job) => job.question?.id === question.id)?.question;

  const { data, reading } = useFreshRequest(
    jobsQuery(botId, "coding"),
    (jobs) => waitingIn(jobs) !== undefined,
  );

  const waiting = data && waitingIn(data);

  if (waiting)
    return (
      <JobQuestionAnswer botId={botId} job={question.job} question={waiting} />
    );

  return (
    <SettledCard
      icon={IconMessageQuestion}
      title={text}
      outcome={reading ?? "Answered"}
    />
  );
}
