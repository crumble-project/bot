import { Spinner } from "@/components/ui/spinner";
import { JOB_KINDS } from "./kinds";
import { type JobRef } from "./api";
import {
  JOB_FAILURE_EVENT,
  JOB_KIND_NAMES,
  isJobKind,
} from "@crumble/server/contract/tools";
import { jobDetails } from "@crumble/server/contract/tool-details";
import { type Message } from "@/features/chat/api";
import { toolDetailsOf } from "@/features/chat/tool-details";
import { messageCard, type CardChat } from "@/features/chat/message-card";

export function jobOf(message: Message) {
  const kind = JOB_KIND_NAMES.find(
    (each) => JOB_KINDS[each].tool === message.toolName,
  );

  const details =
    kind && toolDetailsOf(message, jobDetails, JOB_KINDS[kind].tool);

  return kind && details
    ? { kind, name: details.name, status: details.status }
    : null;
}

export function JobStatus({ working }: { working: boolean }) {
  return working ? (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Spinner className="size-3" />
      Working
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">Idle</span>
  );
}

function JobCard({
  job,
  chat,
}: {
  job: JobRef & { status?: string | undefined };
  chat: CardChat;
}) {
  const { icon: Icon, label } = JOB_KINDS[job.kind];
  const status = chat.jobStatus(job) ?? job.status;

  return (
    <button
      type="button"
      className="flex w-full max-w-sm items-center gap-3 rounded-xl border p-3 text-left hover:bg-muted/50"
      onClick={() => chat.onOpenJob(job)}
    >
      <Icon className="size-4 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{job.name}</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </span>
      <JobStatus working={status === "working"} />
    </button>
  );
}

export const jobResult = messageCard(jobOf, ({ result, chat }) => (
  <JobCard job={result} chat={chat} />
));

function failureOf({ kind, origin, content }: Message) {
  return kind === JOB_FAILURE_EVENT && isJobKind(origin?.kind) && origin?.name
    ? { job: { kind: origin.kind, name: origin.name }, text: content }
    : null;
}

export const jobFailureEvent = messageCard(failureOf, ({ result, chat }) => {
  const { icon: Icon } = JOB_KINDS[result.job.kind];

  return (
    <button
      type="button"
      className="flex w-full max-w-sm items-center gap-3 rounded-xl border p-3 text-left hover:bg-muted/50"
      onClick={() => chat.onOpenJob(result.job)}
    >
      <Icon className="size-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 text-sm first-letter:uppercase">
        {result.text}
      </span>
    </button>
  );
});
