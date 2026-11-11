import { useState } from "react";
import { type UseQueryResult, useQueries } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { IconCircleCheckFilled, IconCircleXFilled } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorAlert } from "@/components/page";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BotAvatar } from "@/components/bot-avatar";
import type { Bot } from "@/features/bots/api";
import { cn } from "@/lib/utils";
import {
  type Execution,
  type Schedule,
  type ScriptRun,
  scriptRunsQuery,
} from "./api";
import { Heading, TableFrame } from "@/components/table-frame";

const SCRIPT_STATUS = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  timed_out: "Timed out",
  interrupted: "Interrupted",
} satisfies Record<ScriptRun["status"], string>;

function runDuration(run: ScriptRun) {
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();

  return `${Math.max(0, (end - Date.parse(run.startedAt)) / 1000).toFixed(1)} s`;
}

function RunDetails({ run }: { run: ScriptRun }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        <span>{SCRIPT_STATUS[run.status].toLowerCase()}</span>
        <span>Exit code: {run.exitCode ?? "—"}</span>
        <time dateTime={run.startedAt}>
          {new Date(run.startedAt).toLocaleString()}
        </time>
        <span>Duration: {runDuration(run)}</span>
      </div>
      {run.error && <p className="text-destructive">{run.error}</p>}
      {run.droppedBytes > 0 && (
        <p className="text-muted-foreground">
          {run.droppedBytes} bytes omitted
        </p>
      )}
      <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono whitespace-pre-wrap break-all">
        {run.output || "No output"}
      </pre>
    </div>
  );
}

type RunEntry = {
  id: string;
  schedule: Schedule | undefined;
  agentId: string;
  startedAt: string;
  status: { label: string; failed: boolean; running: boolean };
  script?: ScriptRun;
};

const EXECUTION_STATUS = {
  pending: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
} satisfies Record<Execution["status"], string>;

const RUNS_SHOWN = 100;

function useRunEntries(schedules: Schedule[], executions: Execution[]) {
  const byId = new Map(schedules.map((schedule) => [schedule.id, schedule]));
  const scripts = schedules.filter((schedule) => schedule.kind === "script");

  const scriptRuns = useQueries({
    queries: scripts.map((schedule) => scriptRunsQuery(schedule.id)),
  });

  const prompts = executions.flatMap((execution): RunEntry[] =>
    execution.scheduleId
      ? [
          {
            id: execution.id,
            schedule: byId.get(execution.scheduleId),
            agentId: execution.agentId,
            startedAt: execution.createdAt,
            status: {
              label: EXECUTION_STATUS[execution.status],
              failed: execution.status === "failed",
              running:
                execution.status === "running" ||
                execution.status === "pending",
            },
          },
        ]
      : [],
  );

  const runs = scriptRuns.flatMap((query) =>
    (query.data ?? []).map((run): RunEntry => ({
      id: run.id,
      schedule: byId.get(run.scheduleId),
      agentId: run.agentId,
      startedAt: run.startedAt,
      status: {
        label: SCRIPT_STATUS[run.status],
        failed: run.status !== "succeeded" && run.status !== "running",
        running: run.status === "running",
      },
      script: run,
    })),
  );

  return [...prompts, ...runs]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, RUNS_SHOWN);
}

function RunStatus({ status }: { status: RunEntry["status"] }) {
  if (status.running)
    return (
      <span className="flex items-center gap-1.5">
        <Spinner className="text-muted-foreground" />
        {status.label}
      </span>
    );

  const Icon = status.failed ? IconCircleXFilled : IconCircleCheckFilled;

  return (
    <span className="flex items-center gap-1.5">
      <Icon
        className={cn(
          "size-4",
          status.failed
            ? "text-destructive"
            : "text-emerald-600 dark:text-emerald-400",
        )}
      />
      {status.label}
    </span>
  );
}

function RunRow({
  entry,
  bot,
  onOpen,
}: {
  entry: RunEntry;
  bot: Bot | undefined;
  onOpen: () => void;
}) {
  const started = new Date(entry.startedAt);

  return (
    <TableRow className="cursor-pointer border-0" onClick={onOpen}>
      <TableCell className="w-full max-w-0 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          {bot && <BotAvatar bot={bot} size={28} />}
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium">
              {entry.schedule?.name ?? "Deleted automation"}
            </span>
            <span className="truncate text-muted-foreground">
              {bot?.name ?? "Deleted bot"}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">
        <time dateTime={entry.startedAt}>
          {started.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </TableCell>
      <TableCell className="hidden text-muted-foreground tabular-nums md:table-cell">
        {entry.script ? runDuration(entry.script) : "—"}
      </TableCell>
      <TableCell>
        <RunStatus status={entry.status} />
      </TableCell>
    </TableRow>
  );
}

function NoRuns() {
  return (
    <Empty className="rounded-xl border">
      <EmptyHeader>
        <EmptyTitle className="font-heading text-lg">No runs yet</EmptyTitle>
        <EmptyDescription>
          Each time an automation runs, it shows up here.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function RunsHeader() {
  return (
    <TableHeader>
      <TableRow className="border-0 hover:bg-transparent">
        <Heading>Automation</Heading>
        <Heading className="hidden sm:table-cell">Started</Heading>
        <Heading className="hidden md:table-cell">Duration</Heading>
        <Heading>Status</Heading>
      </TableRow>
    </TableHeader>
  );
}

function RunOutputDialog({
  title,
  run,
  onClose,
}: {
  title: string;
  run: ScriptRun;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <RunDetails run={run} />
      </DialogContent>
    </Dialog>
  );
}

export function RunsBody({
  bots,
  schedules,
  executions,
}: {
  bots: Bot[];
  schedules: Schedule[];
  executions: UseQueryResult<Execution[]>;
}) {
  const navigate = useNavigate();
  const entries = useRunEntries(schedules, executions.data ?? []);
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const [output, setOutput] = useState<RunEntry | null>(null);

  if (executions.isPending) return <Skeleton className="h-40 rounded-xl" />;

  if (executions.isError)
    return <ErrorAlert>{executions.error.message}</ErrorAlert>;

  if (!entries.length) return <NoRuns />;

  return (
    <>
      <TableFrame>
        <RunsHeader />
        <TableBody>
          {entries.map((entry) => (
            <RunRow
              key={entry.id}
              entry={entry}
              bot={byId.get(entry.agentId)}
              onOpen={() =>
                entry.script
                  ? setOutput(entry)
                  : navigate({
                      to: "/bots/$botId",
                      params: { botId: entry.agentId },
                    })
              }
            />
          ))}
        </TableBody>
      </TableFrame>
      {output?.script && (
        <RunOutputDialog
          title={output.schedule?.name ?? "Deleted automation"}
          run={output.script}
          onClose={() => setOutput(null)}
        />
      )}
    </>
  );
}
