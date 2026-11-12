import { useState } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  IconChevronDown,
  IconChevronRight,
  IconDeviceDesktop,
  IconDownload,
  IconFileText,
  IconPencil,
  IconPointer,
  IconTerminal2,
  IconTool,
  IconX,
} from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JobQuestionAnswer } from "./job-question-answer";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { type Job, jobPath, useJobs } from "./api";
import { JobStatus } from "./job-card";
import { type Message, historyPage } from "@/features/chat/api";
import { api } from "@/lib/api";
import { JOB_KINDS } from "./kinds";
import { type JobRef } from "./api";
import { Reply } from "@/components/markdown";
import { usageDocument } from "@crumble/server/contract/tool-details";
import { blocksOf } from "@/features/chat/tool-details";

/** A job's cost over its models. Subscription providers such as Claude Code report zero, which says nothing. */
export function costLine(usage: Job["usage"]) {
  const models = Object.values(
    usageDocument.safeParse(usage).data?.models ?? {},
  );

  const cost = models.reduce((sum, model) => sum + (model.cost?.total ?? 0), 0);

  return cost > 0 ? `$${cost.toFixed(4)}` : null;
}

const STEP_ICONS = {
  terminal: IconTerminal2,
  file: IconFileText,
  pencil: IconPencil,
  pointer: IconPointer,
  tool: IconTool,
};

type Item = JobHistoryPage["items"][number];

type StepItem = Extract<Item, { kind: "step" }>;

function StepIcon({ item }: { item: StepItem }) {
  const Icon = STEP_ICONS[item.icon];

  return item.result ? (
    <Icon className="size-4 shrink-0 text-muted-foreground" />
  ) : (
    <Spinner className="size-4 shrink-0" />
  );
}

function StepSummary({ item, open }: { item: StepItem; open: boolean }) {
  const Chevron = open ? IconChevronDown : IconChevronRight;

  return (
    <>
      <StepIcon item={item} />
      <span className="shrink-0 font-medium">{item.label}</span>
      {item.subject && (
        <code className="truncate font-mono text-xs text-muted-foreground">
          {item.subject}
        </code>
      )}
      {item.result?.isError && <Badge variant="destructive">Failed</Badge>}
      {item.result && (
        <Chevron className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-aria-expanded:opacity-100" />
      )}
    </>
  );
}

function Step({ item }: { item: StepItem }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <button
        type="button"
        className="group flex min-w-0 items-center gap-2 text-left disabled:cursor-default"
        aria-expanded={open}
        disabled={!item.result}
        onClick={() => setOpen(!open)}
      >
        <StepSummary item={item} open={open} />
      </button>
      {open && item.result && (
        <pre className="ml-6 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
          {item.result.content.replace(/\n+$/, "") || "No output."}
        </pre>
      )}
    </div>
  );
}

function JobItem({ item }: { item: Item }) {
  if (item.kind === "task")
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Task</span>
        <div className="rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap">
          {item.text}
        </div>
      </div>
    );

  if (item.kind === "reply")
    return (
      <div className="text-sm">
        <Reply source={item.text} />
      </div>
    );

  return <Step item={item} />;
}

function JobHistoryError({
  label,
  onRetry,
}: {
  label: string;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex items-center justify-between gap-2">
        Couldn't load this {label}.
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

const STEP_REFRESH_MS = 3_000;

type JobHistoryRoute = "codingJobHistory" | "desktopJobHistory";

type JobHistoryPage = Awaited<ReturnType<typeof api<JobHistoryRoute>>>;

function useJobHistory(botId: string, job: JobRef, status?: string) {
  const base = `${jobPath(botId, job.kind, job.name)}/history` as const;

  const history = useInfiniteQuery({
    queryKey: ["job-history", botId, job.kind, job.name, status],
    queryFn: ({ pageParam, signal }) =>
      api<JobHistoryRoute>(historyPage(base, 100, pageParam), { signal }),
    initialPageParam: "",
    getNextPageParam: (page) =>
      page.hasMore && page.oldestEntryId ? page.oldestEntryId : undefined,
    // Each finished step appears while the job works; the job list's events change `status` when it ends.
    refetchInterval: status === "working" ? STEP_REFRESH_MS : false,
  });

  const items = (history.data?.pages ?? [])
    .toReversed()
    .flatMap((page) => page.items);

  return { history, items };
}

function JobHistoryBody({
  history,
  items,
  label,
  working,
}: {
  history: ReturnType<typeof useJobHistory>["history"];
  items: Item[];
  label: string;
  working: boolean;
}) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport preserveScrollOnPrepend>
          <MessageScrollerContent className="gap-5 p-4">
            {history.hasNextPage && (
              <MessageScrollerItem messageId="earlier">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={history.isFetchingNextPage}
                  onClick={() => void history.fetchNextPage()}
                >
                  Load earlier activity
                </Button>
              </MessageScrollerItem>
            )}
            {history.isPending && <Spinner className="mx-auto" />}
            {history.isError && (
              <JobHistoryError
                label={label}
                onRetry={() => void history.refetch()}
              />
            )}
            {history.isSuccess && items.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing here yet.</p>
            )}
            {items.map((item) => (
              <MessageScrollerItem key={item.id} messageId={item.id}>
                <JobItem item={item} />
              </MessageScrollerItem>
            ))}
            {working && (
              <MessageScrollerItem messageId="working">
                <p className="shimmer text-sm">Working…</p>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/** A fence longer than any backtick run in the text, so the text can't close it. */
function fenced(text: string, info = "") {
  const longest = Math.max(
    2,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );

  const fence = "`".repeat(longest + 1);

  return `${fence}${info}\n${text}\n${fence}`;
}

function messageMarkdown(message: Message) {
  if (message.role === "user") return [`## Task\n\n${message.content}`];

  if (message.role === "toolResult")
    return [
      `${message.isError ? "Failed:\n\n" : ""}${fenced(message.content)}`,
    ];

  if (message.role !== "assistant") return [];

  return blocksOf(message).flatMap((block) => {
    if (block.type === "text" && block.text?.trim()) return [block.text];

    if (block.type === "toolCall" && block.name)
      return [
        `### ${block.name}\n\n${fenced(JSON.stringify(block.arguments ?? {}, null, 2), "json")}`,
      ];

    return [];
  });
}

async function fullHistory(botId: string, job: JobRef) {
  const base = `${jobPath(botId, job.kind, job.name)}/history` as const;

  const pages: JobHistoryPage[] = [];
  let before: string | null = null;

  do {
    const page: JobHistoryPage = await api<JobHistoryRoute>(
      historyPage(base, 200, before),
    );

    pages.push(page);
    before = page.hasMore ? page.oldestEntryId : null;
  } while (before);

  return pages.toReversed().flatMap((page) => page.messages);
}

async function downloadTranscript(botId: string, job: JobRef) {
  const messages = await fullHistory(botId, job);

  const markdown = [
    `# ${job.name}`,
    JOB_KINDS[job.kind].label,
    ...messages.flatMap(messageMarkdown),
  ]
    .join("\n\n")
    .concat("\n");

  const url = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown" }),
  );

  const link = document.createElement("a");

  link.href = url;
  link.download = `${job.name}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function JobTitle({ job, current }: { job: JobRef; current: Job | undefined }) {
  const { icon: Icon } = JOB_KINDS[job.kind];

  const subtitle = [current?.model?.model, costLine(current?.usage)];

  return (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-heading font-semibold leading-tight">
          {job.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {subtitle.filter(Boolean).join(" · ")}
        </span>
      </span>
    </>
  );
}

function DownloadButton({ botId, job }: { botId: string; job: JobRef }) {
  // Reads every page on demand; nothing cached changes.
  // react-doctor-disable-next-line query-mutation-missing-invalidation
  const download = useMutation({
    mutationFn: () => downloadTranscript(botId, job),
  });

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={
        download.isError
          ? "Couldn't download the transcript. Try again."
          : "Download transcript"
      }
      disabled={download.isPending}
      onClick={() => download.mutate()}
    >
      {download.isPending ? <Spinner /> : <IconDownload />}
    </Button>
  );
}

function JobPanelHeader({
  botId,
  job,
  current,
  working,
  onClose,
}: {
  botId: string;
  job: JobRef;
  current: Job | undefined;
  working: boolean;
  onClose: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4">
      <JobTitle job={job} current={current} />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <span className="mr-1">
          <JobStatus working={working} />
        </span>
        {JOB_KINDS[job.kind].onDesktop && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Bot desktop"
            render={<Link to="/bots/$botId/desktop" params={{ botId }} />}
            nativeButton={false}
          >
            <IconDeviceDesktop />
          </Button>
        )}
        <DownloadButton botId={botId} job={job} />
        <Button variant="ghost" size="icon-sm" title="Close" onClick={onClose}>
          <IconX />
        </Button>
      </div>
    </header>
  );
}

export function JobPanel({
  botId,
  job,
  onClose,
}: {
  botId: string;
  job: JobRef;
  onClose: () => void;
}) {
  const jobs = useJobs(botId, job.kind);
  const current = jobs.data?.find((each) => each.name === job.name);
  const working = current?.status === "working";
  const { history, items } = useJobHistory(botId, job, current?.status);

  return (
    <aside
      aria-label={job.name}
      className="flex min-h-0 flex-col border-l bg-background max-lg:fixed max-lg:inset-0 max-lg:z-40 lg:w-[min(42rem,50%)] lg:shrink-0"
    >
      <JobPanelHeader
        botId={botId}
        job={job}
        current={current}
        working={working}
        onClose={onClose}
      />
      {job.kind === "coding" && current?.question && (
        <div className="shrink-0 border-b p-4">
          <JobQuestionAnswer
            botId={botId}
            job={job.name}
            question={current.question}
          />
        </div>
      )}
      <JobHistoryBody
        history={history}
        items={items}
        label={JOB_KINDS[job.kind].label.toLowerCase()}
        working={working}
      />
    </aside>
  );
}
