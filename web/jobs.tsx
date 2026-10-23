import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MonitorIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
} from "./api";
import { Reply } from "./markdown";

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

  const format = new Intl.NumberFormat();

  return `${format.format(totals.input)} in · ${format.format(totals.output)} out · $${totals.cost.toFixed(4)}`;
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
      subject?: string;
      result?: Message;
    };

function blocksOf(message: Message): Block[] {
  // SAFETY: Provider content blocks are objects with a `type`.
  return Array.isArray(message.blocks) ? (message.blocks as Block[]) : [];
}

function itemsOf(messages: Message[]) {
  const items: Item[] = [];
  const steps = new Map<string, Extract<Item, { kind: "step" }>>();

  for (const message of messages) {
    if (message.role === "user" && message.content.trim())
      items.push({ kind: "task", id: message.id, text: message.content });

    if (message.role === "assistant")
      for (const [index, block] of blocksOf(message).entries()) {
        if (block.type === "text" && block.text?.trim())
          items.push({
            kind: "reply",
            id: `${message.id}:${index}`,
            text: block.text,
          });

        if (block.type === "toolCall" && block.name) {
          const step = {
            kind: "step" as const,
            id: block.id ?? `${message.id}:${index}`,
            tool: block.name,
            subject: block.arguments?.command ?? block.arguments?.path,
          };

          steps.set(step.id, step);
          items.push(step);
        }
      }

    if (message.role === "toolResult" && message.toolCallId) {
      const step = steps.get(message.toolCallId);

      if (step) step.result = message;
    }
  }

  return items;
}

function Step({ item }: { item: Extract<Item, { kind: "step" }> }) {
  const verb =
    VERBS.get(item.tool) ??
    item.tool.charAt(0).toUpperCase() + item.tool.slice(1);

  const failed = item.result?.isError === true;
  const showOutput = item.result && (item.tool === "bash" || failed);
  const lines = item.result?.content.split("\n") ?? [];
  const hidden = Math.max(0, lines.length - 12);

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
      {showOutput && (
        <pre className="max-h-60 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
          {hidden > 0 && (
            <span className="text-muted-foreground">
              {hidden} earlier lines not shown{"\n"}
            </span>
          )}
          {lines.slice(-12).join("\n")}
        </pre>
      )}
    </div>
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
  status?: string;
  usage?: CodingJob["usage"];
  onClose: () => void;
}) {
  const label = job.kind === "coding" ? "coding job" : "desktop job";
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
  });

  const messages = (history.data?.pages ?? [])
    .toReversed()
    .flatMap((page) => page.messages);

  const items = itemsOf(messages);
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
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void history.refetch()}
          >
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
          {job.kind === "desktop" && (
            <Button
              variant="outline"
              size="sm"
              render={<Link to="/bots/$botId/desktop" params={{ botId }} />}
              nativeButton={false}
            >
              <MonitorIcon data-icon="inline-start" />
              Open bot desktop
            </Button>
          )}
        </div>
        <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
          {history.hasNextPage && (
            <Button
              variant="ghost"
              size="sm"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              Load earlier activity
            </Button>
          )}
          {history.isPending && <Spinner className="mx-auto" />}
          {history.isError && (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-2">
                Couldn't load this {label}.
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void history.refetch()}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {history.isSuccess && items.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing here yet.</p>
          )}
          {items.map((item) =>
            item.kind === "task" ? (
              <div key={item.id} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Task
                </span>
                <div className="rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap">
                  {item.text}
                </div>
              </div>
            ) : item.kind === "reply" ? (
              <div key={item.id} className="text-sm">
                <Reply source={item.text} />
              </div>
            ) : (
              <Step key={item.id} item={item} />
            ),
          )}
          {status === "working" && <p className="shimmer text-sm">Working…</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
