import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { IconDeviceDesktop, IconRefresh } from "@tabler/icons-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  type CodingJob,
  type HistoryPage,
  type Message,
  agentPath,
  api,
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

const VERBS = new Map([
  ["bash", "Ran"],
  ["read", "Read"],
  ["write", "Wrote"],
  ["edit", "Edited"],
  ["computer_use", "Used the bot desktop"],
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

function StepOutput({ content }: { content: string }) {
  const lines = content.split("\n");
  const hidden = Math.max(0, lines.length - 12);

  return (
    <pre className="max-h-60 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
      {hidden > 0 && (
        <span className="text-muted-foreground">
          {hidden} earlier lines not shown{"\n"}
        </span>
      )}
      {lines.slice(-12).join("\n")}
    </pre>
  );
}

function verbOf(tool: string) {
  return VERBS.get(tool) ?? tool.charAt(0).toUpperCase() + tool.slice(1);
}

function Step({ item }: { item: StepItem }) {
  const verb = verbOf(item.tool);
  const failed = item.result?.isError === true;

  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-2">
        {!item.result && <Spinner className="size-3" />}
        <span className="font-medium">{verb}</span>
        {item.subject && (
          <code className="truncate font-mono text-xs text-muted-foreground">
            {item.subject}
          </code>
        )}
        {failed && <Badge variant="destructive">Failed</Badge>}
      </div>
      {item.result && (item.tool === "bash" || failed) && (
        <StepOutput content={item.result.content} />
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

function JobActions({
  botId,
  kind,
  onRefresh,
}: {
  botId: string;
  kind: JobRef["kind"];
  onRefresh: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={onRefresh}>
        <IconRefresh data-icon="inline-start" />
        Refresh
      </Button>
      {kind === "desktop" && (
        <Button
          variant="outline"
          size="sm"
          render={<Link to="/bots/$botId/desktop" params={{ botId }} />}
          nativeButton={false}
        >
          <IconDeviceDesktop data-icon="inline-start" />
          Open bot desktop
        </Button>
      )}
    </div>
  );
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
      <MessageScroller className="-mx-4 min-h-0 flex-1">
        <MessageScrollerViewport preserveScrollOnPrepend>
          <MessageScrollerContent className="gap-4 px-4">
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

/** A job's task, replies and tool steps, read-only. */
export function JobDialog({
  botId,
  job,
  status,
  usage,
  onClose,
}: {
  botId: string;
  job: JobRef;
  status?: string | undefined;
  usage?: CodingJob["usage"];
  onClose: () => void;
}) {
  const label = job.kind === "coding" ? "coding job" : "desktop job";
  const { history, items } = useJobHistory(botId, job, status);
  const cost = usageLine(usage);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{job.name}</DialogTitle>
          <DialogDescription>
            {job.kind === "coding" ? "Coding job" : "Desktop job"}
            {cost && ` · ${cost}`}
          </DialogDescription>
        </DialogHeader>
        <JobActions
          botId={botId}
          kind={job.kind}
          onRefresh={() => void history.refetch()}
        />
        <JobHistoryBody
          history={history}
          items={items}
          label={label}
          working={status === "working"}
        />
      </DialogContent>
    </Dialog>
  );
}
