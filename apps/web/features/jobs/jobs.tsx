import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  IconChevronDown,
  IconChevronRight,
  IconDeviceDesktop,
  IconDownload,
  IconFileText,
  IconHammer,
  IconPencil,
  IconPointer,
  IconTerminal2,
  IconTool,
  IconX,
} from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import {
  type CodingJob,
  type HistoryPage,
  type Message,
  agentPath,
  api,
  jobsQuery,
} from "@/lib/api";
import { Reply } from "@/components/markdown";

export type JobRef = { kind: "coding" | "desktop"; name: string };

type Block = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: { command?: string; path?: string };
};

type Totals = { input: number; output: number; cost: number };

type UsageModels = {
  models?: Record<
    string,
    {
      input?: number;
      output?: number;
      cacheRead?: number;
      cost?: { total?: number };
    }
  >;
};

const numberFormat = new Intl.NumberFormat();

/** Sums a job's token use and cost over its models, as `{in} in · {out} out · $cost`. */
export function usageLine(usage: CodingJob["usage"]) {
  // SAFETY: Pi Durable usage documents keep per-model token counts and cost under `models`.
  const models = Object.values(
    (usage as UsageModels | undefined)?.models ?? {},
  );

  if (models.length === 0) return null;

  const totals = models.reduce<Totals>(
    (sum, model) => ({
      input: sum.input + (model.input ?? 0) + (model.cacheRead ?? 0),
      output: sum.output + (model.output ?? 0),
      cost: sum.cost + (model.cost?.total ?? 0),
    }),
    { input: 0, output: 0, cost: 0 },
  );

  return `${numberFormat.format(totals.input)} in · ${numberFormat.format(totals.output)} out · $${totals.cost.toFixed(4)}`;
}

const STEPS = new Map([
  ["bash", { verb: "Ran", icon: IconTerminal2 }],
  ["read", { verb: "Read", icon: IconFileText }],
  ["write", { verb: "Wrote", icon: IconPencil }],
  ["edit", { verb: "Edited", icon: IconPencil }],
  ["computer_use", { verb: "Used the bot desktop", icon: IconPointer }],
]);

type Item =
  | { kind: "task"; id: string; text: string }
  | { kind: "reply"; id: string; text: string }
  | {
      kind: "step";
      id: string;
      tool: string;
      subject?: string | undefined;
      result?: Message;
    };

function blocksOf(message: Message): Block[] {
  // SAFETY: Provider content blocks are objects with a `type`.
  return Array.isArray(message.blocks) ? (message.blocks as Block[]) : [];
}

type StepItem = Extract<Item, { kind: "step" }>;

function stepOf(message: Message, block: Block, index: number) {
  return {
    kind: "step" as const,
    id: block.id ?? `${message.id}:${index}`,
    tool: block.name ?? "",
    subject: block.arguments?.command ?? block.arguments?.path,
  };
}

function assistantItems(message: Message, steps: Map<string, StepItem>) {
  const items: Item[] = [];

  for (const [index, block] of blocksOf(message).entries()) {
    if (block.type === "text" && block.text?.trim())
      items.push({
        kind: "reply",
        id: `${message.id}:${index}`,
        text: block.text,
      });

    if (block.type === "toolCall" && block.name) {
      const step = stepOf(message, block, index);

      steps.set(step.id, step);
      items.push(step);
    }
  }

  return items;
}

function itemsOf(messages: Message[]) {
  const items: Item[] = [];
  const steps = new Map<string, StepItem>();

  for (const message of messages) {
    if (message.role === "user" && message.content.trim())
      items.push({ kind: "task", id: message.id, text: message.content });

    if (message.role === "assistant")
      items.push(...assistantItems(message, steps));

    if (message.role === "toolResult" && message.toolCallId) {
      const step = steps.get(message.toolCallId);

      if (step) step.result = message;
    }
  }

  return items;
}

function verbOf(tool: string) {
  return STEPS.get(tool)?.verb ?? tool.charAt(0).toUpperCase() + tool.slice(1);
}

function Step({ item }: { item: StepItem }) {
  const [open, setOpen] = useState(false);
  const verb = verbOf(item.tool);
  const Icon = STEPS.get(item.tool)?.icon ?? IconTool;
  const failed = item.result?.isError === true;
  const Chevron = open ? IconChevronDown : IconChevronRight;

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <button
        type="button"
        className="group flex min-w-0 items-center gap-2 text-left disabled:cursor-default"
        aria-expanded={open}
        disabled={!item.result}
        onClick={() => setOpen(!open)}
      >
        {item.result ? (
          <Icon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Spinner className="size-4 shrink-0" />
        )}
        <span className="shrink-0 font-medium">{verb}</span>
        {item.subject && (
          <code className="truncate font-mono text-xs text-muted-foreground">
            {item.subject}
          </code>
        )}
        {failed && <Badge variant="destructive">Failed</Badge>}
        {item.result && (
          <Chevron className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-aria-expanded:opacity-100" />
        )}
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

function useJobHistory(botId: string, job: JobRef, status?: string) {
  const base = `${agentPath(botId)}/${job.kind}-jobs/${encodeURIComponent(job.name)}/history`;

  const history = useInfiniteQuery({
    queryKey: ["job-history", botId, job.kind, job.name, status],
    queryFn: ({ pageParam, signal }) =>
      api<HistoryPage>(
        `${base}?limit=100${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
      ),
    initialPageParam: "",
    getNextPageParam: (page) =>
      page.hasMore && page.oldestEntryId ? page.oldestEntryId : undefined,
    // Each finished step appears while the job works; the job list's events change `status` when it ends.
    refetchInterval: status === "working" ? STEP_REFRESH_MS : false,
  });

  const messages = (history.data?.pages ?? [])
    .toReversed()
    .flatMap((page) => page.messages);

  return { history, items: itemsOf(messages) };
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

/** Every page of a job's transcript, oldest message first. */
async function fullHistory(botId: string, job: JobRef) {
  const base = `${agentPath(botId)}/${job.kind}-jobs/${encodeURIComponent(job.name)}/history?limit=200`;
  const pages: HistoryPage[] = [];
  let before: string | null = null;

  do {
    const page: HistoryPage = await api<HistoryPage>(
      before ? `${base}&before=${encodeURIComponent(before)}` : base,
    );

    pages.push(page);
    before = page.hasMore ? page.oldestEntryId : null;
  } while (before);

  return pages.toReversed().flatMap((page) => page.messages);
}

async function downloadTranscript(botId: string, job: JobRef) {
  const messages = await fullHistory(botId, job);
  const kind = job.kind === "coding" ? "Coding job" : "Desktop job";

  const markdown = [`# ${job.name}`, kind, ...messages.flatMap(messageMarkdown)]
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

/** Whether a job works, as its card and panel show it. */
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

const JOB_REFRESH_MS = 3_000;
const IDLE_JOB_REFRESH_MS = 15_000;

function useLiveJob(botId: string, job: JobRef) {
  const jobs = useQuery({
    ...jobsQuery(botId, job.kind),
    // The chat refreshes its job list only when job messages arrive, which misses a job's own progress.
    refetchInterval: (query) =>
      query.state.data?.some(
        (each) => each.name === job.name && each.status === "working",
      )
        ? JOB_REFRESH_MS
        : IDLE_JOB_REFRESH_MS,
  });

  return jobs.data?.find((each) => each.name === job.name);
}

/** A job's task, replies and tool steps, read-only, in a pane beside the chat. */
export function JobPanel({
  botId,
  job,
  onClose,
}: {
  botId: string;
  job: JobRef;
  onClose: () => void;
}) {
  const current = useLiveJob(botId, job);
  const working = current?.status === "working";
  const { history, items } = useJobHistory(botId, job, current?.status);
  const cost = usageLine(current?.usage);
  const Icon = job.kind === "coding" ? IconHammer : IconDeviceDesktop;

  // Reads every page on demand; nothing cached changes.
  // react-doctor-disable-next-line query-mutation-missing-invalidation
  const download = useMutation({
    mutationFn: () => downloadTranscript(botId, job),
  });

  return (
    <aside
      aria-label={job.name}
      className="flex min-h-0 flex-col border-l bg-background max-lg:fixed max-lg:inset-0 max-lg:z-40 lg:w-[min(42rem,50%)] lg:shrink-0"
    >
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-heading font-semibold leading-tight">
            {job.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {[
              job.kind === "coding" ? "Coding job" : "Desktop job",
              current?.model?.model,
              cost,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span className="mr-1">
            <JobStatus working={working} />
          </span>
          {job.kind === "desktop" && (
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
          <Button
            variant="ghost"
            size="icon-sm"
            title="Close"
            onClick={onClose}
          >
            <IconX />
          </Button>
        </div>
      </header>
      <JobHistoryBody
        history={history}
        items={items}
        label={job.kind === "coding" ? "coding job" : "desktop job"}
        working={working}
      />
    </aside>
  );
}
