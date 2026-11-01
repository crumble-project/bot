import { type ReactNode, useState } from "react";
import cronstrue from "cronstrue";
import { CronExpressionParser } from "cron-parser";
import {
  type UseQueryResult,
  useMutation,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  IconCircleCheck,
  IconClock,
  IconCircleCheckFilled,
  IconCircleXFilled,
  IconDots,
  IconMessage,
  IconPencil,
  IconPlayerPause,
  IconPlayerPauseFilled,
  IconPlayerPlay,
  IconPlus,
  IconTerminal2,
  IconTrash,
  IconWebhook,
  type TablerIcon,
} from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type Bot,
  type EventSource,
  type Execution,
  type Schedule,
  type ScriptRun,
  botsQuery,
  call,
  capabilitiesQuery,
  eventSourcesQuery,
  executionsQuery,
  queryClient,
  schedulesQuery,
  scriptRunsQuery,
  send,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { BotAvatar } from "@/features/bots/avatar";
import {
  EditorSection,
  EditorSheet,
  SelectOptions,
} from "@/components/form-fields";
import { ConfirmDeleteContent, WorkspacePage } from "@/components/workspace";

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function describeCron(cron: string, timezone: string) {
  const zone = timezone !== LOCAL_ZONE ? ` (${timezone})` : "";
  const plain = `${cron}${zone}`;
  const fields = cron.trim().split(/\s+/);

  const days =
    fields.length === 6 ? [fields[3], fields[5]] : [fields[2], fields[4]];

  if (
    (fields.length === 5 || fields.length === 6) &&
    days.every((day) => day !== "*" && day !== "?")
  )
    return plain;

  // The scheduler reads weekday `1/2` as `1-7/2`; cronstrue stops at Saturday.
  if (days[1]?.split(",").some((part) => /^[^*-]+\//.test(part))) return plain;

  try {
    return `${cronstrue.toString(cron, { use24HourTimeFormat: true })}${zone}`;
  } catch {
    return plain;
  }
}

export function describeTiming(schedule: Schedule, sources?: EventSource[]) {
  if (schedule.eventSourceId) {
    const source = sources?.find((each) => each.id === schedule.eventSourceId);

    return source ? `On event · ${source.name}` : "On event";
  }

  if (schedule.cron) return describeCron(schedule.cron, schedule.timezone);

  if (!schedule.runAt) return "Once";

  const date = new Date(schedule.runAt);

  const text = date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: schedule.timezone,
  });

  return date.getTime() < Date.now() && !schedule.nextRunAt
    ? `Ran ${text}`
    : `Once, ${text}`;
}

/** An automation's timing as the Mac app shows it, prefixed "Paused · " when disabled. */
export function automationTiming(schedule: Schedule, sources?: EventSource[]) {
  return `${schedule.enabled ? "" : "Paused · "}${describeTiming(schedule, sources)}`;
}

function validZone(zone: string) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });

    return true;
  } catch {
    return false;
  }
}

/** The wall-clock `YYYY-MM-DDTHH:mm` of `date` in `zone`, for a datetime-local input. */
function wallClock(date: Date, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );

  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`;
}

/** The instant whose wall clock in `zone` reads `local`; null when `local` is not a date. */
function fromWallClock(local: string, zone: string) {
  const guess = new Date(`${local}:00Z`);

  if (Number.isNaN(guess.getTime())) return null;

  let instant = guess.getTime();

  // Two passes settle the zone offset, also across a daylight-saving change.
  for (let pass = 0; pass < 2; pass++) {
    const shown = new Date(`${wallClock(new Date(instant), zone)}:00Z`);
    instant += guess.getTime() - shown.getTime();
  }

  return new Date(instant);
}

function inOneHour(zone: string) {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);

  return wallClock(date, zone);
}

type Editing = { schedule: Schedule | null; agentId: string };

/** A one-off automation that already ran; its result is in the bot's chat. */
export const finished = (schedule: Schedule) =>
  !schedule.cron && !schedule.eventSourceId && !schedule.nextRunAt;

type Status = "active" | "paused" | "completed";

const statusOf = (schedule: Schedule): Status => {
  if (finished(schedule)) return "completed";

  return schedule.enabled ? "active" : "paused";
};

const STATUS = {
  active: {
    label: "Active",
    icon: IconCircleCheckFilled,
    className: "text-emerald-600 dark:text-emerald-400",
  },
  paused: {
    label: "Paused",
    icon: IconPlayerPauseFilled,
    className: "text-muted-foreground",
  },
  completed: {
    label: "Completed",
    icon: IconCircleCheck,
    className: "text-muted-foreground",
  },
} satisfies Record<
  Status,
  { label: string; icon: TablerIcon; className: string }
>;

const RANK = { active: 0, paused: 1, completed: 2 } satisfies Record<
  Status,
  number
>;

const nextTime = (schedule: Schedule) =>
  schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : Infinity;

/** Active automations soonest first, then paused ones, then finished script automations. */
function listed(schedules: Schedule[]) {
  return schedules
    .filter((schedule) => schedule.kind === "script" || !finished(schedule))
    .sort((a, b) => {
      const rank = RANK[statusOf(a)] - RANK[statusOf(b)];

      if (rank) return rank;

      if (nextTime(a) === nextTime(b)) return a.name.localeCompare(b.name);

      return nextTime(a) < nextTime(b) ? -1 : 1;
    });
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** How soon a run starts, for runs within the next day. */
function soon(date: Date, now: Date) {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000);

  if (minutes < 60) return relative.format(Math.max(minutes, 0), "minute");

  return relative.format(Math.round(minutes / 60), "hour");
}

function nextRunLabel(schedule: Schedule, now: Date) {
  if (!schedule.enabled || !schedule.nextRunAt) return "—";

  const next = new Date(schedule.nextRunAt);

  if (next.getTime() - now.getTime() < 86_400_000) return soon(next, now);

  return next.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AutomationsEmpty({
  firstBot,
  onCreate,
}: {
  firstBot?: Bot | undefined;
  onCreate: () => void;
}) {
  return (
    <Empty className="rounded-xl border">
      <EmptyHeader>
        <EmptyTitle className="font-heading text-lg">
          No automations yet
        </EmptyTitle>
        <EmptyDescription>
          {firstBot
            ? "An automation sends a bot a message once or on a schedule, and the bot answers in its chat."
            : "Create a bot, then give it an automation to run once or on a schedule."}
        </EmptyDescription>
      </EmptyHeader>
      {firstBot && (
        <EmptyContent>
          <Button onClick={onCreate}>
            <IconPlus data-icon="inline-start" />
            New automation
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

/** The rounded, tinted frame both tables sit in. */
function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-muted/30 px-2 py-1">
      <Table>{children}</Table>
    </div>
  );
}

function Heading({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <TableHead className={cn("font-normal text-muted-foreground", className)}>
      {children}
    </TableHead>
  );
}

function AutomationTable({
  schedules,
  byId,
  onEdit,
}: {
  schedules: Schedule[];
  byId: Map<string, Bot>;
  onEdit: (schedule: Schedule) => void;
}) {
  const now = new Date();

  return (
    <TableFrame>
      <TableHeader>
        <TableRow className="border-0 hover:bg-transparent">
          <Heading>Automation</Heading>
          <Heading className="hidden md:table-cell">When</Heading>
          <Heading className="hidden sm:table-cell">Next run</Heading>
          <Heading>Status</Heading>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {schedules.map((schedule) => {
          const bot = byId.get(schedule.agentId);

          return bot ? (
            <AutomationRow
              key={schedule.id}
              schedule={schedule}
              bot={bot}
              creator={
                schedule.createdByAgentId &&
                schedule.createdByAgentId !== schedule.agentId
                  ? byId.get(schedule.createdByAgentId)
                  : undefined
              }
              now={now}
              onEdit={() => onEdit(schedule)}
            />
          ) : null;
        })}
      </TableBody>
    </TableFrame>
  );
}

function AutomationsBody({
  bots,
  schedules,
  onCreate,
  onEdit,
}: {
  bots: UseQueryResult<Bot[]>;
  schedules: UseQueryResult<Schedule[]>;
  onCreate: () => void;
  onEdit: (schedule: Schedule) => void;
}) {
  const firstBot = bots.data?.[0];
  const byId = new Map(bots.data?.map((bot) => [bot.id, bot]));
  const shown = listed(schedules.data ?? []);

  if (bots.isPending || schedules.isPending)
    return <Skeleton className="h-40 rounded-xl" />;

  if (schedules.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{schedules.error.message}</AlertDescription>
      </Alert>
    );

  if (!shown.length)
    return <AutomationsEmpty firstBot={firstBot} onCreate={onCreate} />;

  return <AutomationTable schedules={shown} byId={byId} onEdit={onEdit} />;
}

export function AutomationsPage() {
  const bots = useQuery(botsQuery);
  const schedules = useQuery(schedulesQuery);
  const executions = useQuery(executionsQuery);
  const [view, setView] = useState<"automations" | "runs">("automations");
  const [editing, setEditing] = useState<Editing | null>(null);
  const firstBot = bots.data?.[0];

  const create = () =>
    firstBot && setEditing({ schedule: null, agentId: firstBot.id });

  return (
    <WorkspacePage
      title="Automations"
      refreshing={
        bots.isFetching || schedules.isFetching || executions.isFetching
      }
      onRefresh={() => {
        void schedules.refetch();
        void bots.refetch();
        void executions.refetch();
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <Tabs
            value={view}
            onValueChange={(value) =>
              setView(value === "runs" ? "runs" : "automations")
            }
          >
            <TabsList>
              <TabsTrigger value="automations">Automations</TabsTrigger>
              <TabsTrigger value="runs">Runs</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button disabled={!firstBot} onClick={create}>
            <IconPlus data-icon="inline-start" />
            New automation
          </Button>
        </div>
        {view === "automations" ? (
          <AutomationsBody
            bots={bots}
            schedules={schedules}
            onCreate={create}
            onEdit={(schedule) =>
              setEditing({ schedule, agentId: schedule.agentId })
            }
          />
        ) : (
          <RunsBody
            bots={bots.data ?? []}
            schedules={schedules.data ?? []}
            executions={executions}
          />
        )}
      </div>
      {editing && (
        <AutomationDialog
          bots={bots.data ?? []}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </WorkspacePage>
  );
}

const refresh = () =>
  queryClient.invalidateQueries({ queryKey: schedulesQuery.queryKey });

export function runAutomationOptions(
  schedule: Pick<Schedule, "id">,
  navigate: () => void,
) {
  const path = `/v1/schedules/${encodeURIComponent(schedule.id)}`;

  return {
    mutationFn: async () => {
      const result = await call<{ admitted: boolean }>(`${path}/run`, "POST");

      if (!result.admitted) throw new Error("Automation could not be started");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: executionsQuery.queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: scriptRunsQuery(schedule.id).queryKey,
      });
      navigate();
    },
  };
}

function useAutomationActions(schedule: Schedule) {
  const navigate = useNavigate();
  const path = `/v1/schedules/${encodeURIComponent(schedule.id)}`;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => send(path, "PATCH", { enabled }),
    onSettled: refresh,
  });

  const run = useMutation(
    runAutomationOptions(schedule, () => {
      void navigate({
        to: "/bots/$botId",
        params: { botId: schedule.agentId },
      });
    }),
  );

  const remove = useMutation({
    mutationFn: () => send(path, "DELETE"),
    onSettled: refresh,
  });

  return { toggle, run, remove };
}

function AutomationName({
  schedule,
  bot,
  creator,
  failure,
}: {
  schedule: Schedule;
  bot: Bot;
  creator?: Bot | undefined;
  failure?: Error | null;
}) {
  const sources = useQuery(eventSourcesQuery).data;

  return (
    <div className="flex min-w-0 items-center gap-3">
      <BotAvatar
        bot={bot}
        size={28}
        state={schedule.enabled ? "idle" : "sleeping"}
      />
      <div className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{schedule.name}</span>
          {schedule.kind === "script" && (
            <Badge variant="outline" className="shrink-0">
              Script
            </Badge>
          )}
        </span>
        <span className="truncate text-muted-foreground">
          {bot.name}
          {creator && ` · by ${creator.name}`}
          <span className="md:hidden">
            {" "}
            · {describeTiming(schedule, sources)}
          </span>
        </span>
        {failure && (
          <span className="truncate text-xs text-destructive">
            {failure.message}
          </span>
        )}
      </div>
    </div>
  );
}

function StatusLabel({ status }: { status: Status }) {
  const { label, icon: Icon, className } = STATUS[status];

  return (
    <span className="flex items-center gap-1.5">
      <Icon className={cn("size-4", className)} />
      {label}
    </span>
  );
}

function AutomationMenu({
  schedule,
  actions,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  actions: ReturnType<typeof useAutomationActions>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { run, toggle } = actions;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" title="More">
            <IconDots />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={!schedule.enabled || run.isPending}
          onClick={() => run.mutate()}
        >
          <IconPlayerPlay />
          Run now
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>
          <IconPencil />
          Edit
        </DropdownMenuItem>
        {!finished(schedule) && (
          <DropdownMenuItem
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(!schedule.enabled)}
          >
            {schedule.enabled ? <IconPlayerPause /> : <IconPlayerPlay />}
            {schedule.enabled ? "Pause" : "Resume"}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <IconTrash />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AutomationRow({
  schedule,
  bot,
  creator,
  now,
  onEdit,
}: {
  schedule: Schedule;
  bot: Bot;
  creator?: Bot | undefined;
  now: Date;
  onEdit: () => void;
}) {
  const actions = useAutomationActions(schedule);
  const { toggle, run, remove } = actions;
  const sources = useQuery(eventSourcesQuery).data;
  const [deleting, setDeleting] = useState(false);

  return (
    <TableRow className="cursor-pointer border-0" onClick={onEdit}>
      <TableCell className="w-full max-w-0 md:w-1/2 py-2.5">
        <AutomationName
          schedule={schedule}
          bot={bot}
          creator={creator}
          failure={toggle.error ?? run.error ?? remove.error}
        />
      </TableCell>
      <TableCell className="hidden w-1/3 max-w-0 truncate text-muted-foreground md:table-cell">
        {describeTiming(schedule, sources)}
      </TableCell>
      <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">
        {nextRunLabel(schedule, now)}
      </TableCell>
      <TableCell>
        <StatusLabel status={statusOf(schedule)} />
      </TableCell>
      <TableCell onClick={(event) => event.stopPropagation()}>
        <AutomationMenu
          schedule={schedule}
          actions={actions}
          onEdit={onEdit}
          onDelete={() => setDeleting(true)}
        />
        <AlertDialog open={deleting} onOpenChange={setDeleting}>
          <ConfirmDeleteContent
            title={`Delete ${schedule.name}?`}
            description="The automation stops running. This cannot be undone."
            onConfirm={() => remove.mutate()}
          />
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}

function runDuration(run: ScriptRun) {
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();

  return `${Math.max(0, (end - Date.parse(run.startedAt)) / 1000).toFixed(1)} s`;
}

function RunDetails({ run }: { run: ScriptRun }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        <span>{run.status.replaceAll("_", " ")}</span>
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

/** One row of the Runs tab: a prompt run opens the bot's chat, a script run its output. */
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

const SCRIPT_STATUS = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  timed_out: "Timed out",
  interrupted: "Interrupted",
} satisfies Record<ScriptRun["status"], string>;

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

function RunsBody({
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
    return (
      <Alert variant="destructive">
        <AlertDescription>{executions.error.message}</AlertDescription>
      </Alert>
    );

  if (!entries.length)
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

  return (
    <>
      <TableFrame>
        <TableHeader>
          <TableRow className="border-0 hover:bg-transparent">
            <Heading>Automation</Heading>
            <Heading className="hidden sm:table-cell">Started</Heading>
            <Heading className="hidden md:table-cell">Duration</Heading>
            <Heading>Status</Heading>
          </TableRow>
        </TableHeader>
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
        <Dialog open onOpenChange={(open) => !open && setOutput(null)}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {output.schedule?.name ?? "Deleted automation"}
              </DialogTitle>
            </DialogHeader>
            <RunDetails run={output.script} />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

type AutomationDraft = {
  agentId: string;
  name: string;
  enabled: boolean;
  prompt: string;
  kind: Schedule["kind"];
  command: string;
  timeoutSeconds: string;
  notify: boolean;
  repeat: boolean;
  cron: string;
  timezone: string;
  runAt: string;
  onEvent: boolean;
  eventSourceId: string;
};

type AutomationBody = {
  agentId: string;
  name: string;
  prompt: string;
  kind: Schedule["kind"];
  command: string | null;
  timeoutSeconds: number;
  notify: boolean;
  timezone: string;
  enabled: boolean;
  cron: string | null;
  runAt: string | null;
  eventSourceId: string | null;
};

const DEFAULT_CRON = "0 9 * * *";

function blankDraft(agentId: string): AutomationDraft {
  return {
    agentId,
    name: "",
    enabled: true,
    prompt: "",
    kind: "prompt",
    command: "",
    timeoutSeconds: "600",
    notify: true,
    repeat: false,
    cron: DEFAULT_CRON,
    timezone: LOCAL_ZONE,
    runAt: inOneHour(LOCAL_ZONE),
    onEvent: false,
    eventSourceId: "",
  };
}

function draftOf(agentId: string, schedule: Schedule): AutomationDraft {
  return {
    agentId,
    name: schedule.name,
    enabled: schedule.enabled,
    prompt: schedule.prompt,
    kind: schedule.kind,
    command: schedule.command ?? "",
    timeoutSeconds: String(schedule.timeoutSeconds),
    notify: schedule.notify,
    repeat: schedule.cron !== null,
    cron: schedule.cron ?? DEFAULT_CRON,
    timezone: schedule.timezone,
    runAt: schedule.runAt
      ? wallClock(new Date(schedule.runAt), schedule.timezone)
      : inOneHour(schedule.timezone),
    onEvent: schedule.eventSourceId !== null,
    eventSourceId: schedule.eventSourceId ?? "",
  };
}

function initialDraft(editing: Editing) {
  return editing.schedule
    ? draftOf(editing.agentId, editing.schedule)
    : blankDraft(editing.agentId);
}

function runTimeError(draft: AutomationDraft) {
  if (draft.onEvent)
    return draft.eventSourceId ? null : "Choose an event source.";

  if (draft.repeat ? !draft.cron.trim() : !draft.runAt)
    return "Choose either a recurring cron or a one-time run time.";

  if (!validZone(draft.timezone.trim())) return "Choose a valid time zone.";

  return null;
}

function kindFields(
  draft: AutomationDraft,
):
  | { error: string }
  | { fields: Pick<AutomationBody, "prompt" | "command" | "timeoutSeconds"> } {
  if (draft.kind === "prompt") {
    if (!draft.name.trim() || !draft.prompt.trim())
      return { error: "Automation name and prompt are required." };

    return {
      fields: {
        prompt: draft.prompt.trim(),
        command: null,
        timeoutSeconds: 600,
      },
    };
  }

  if (!draft.name.trim() || !draft.command.trim())
    return { error: "Automation name and command are required." };

  const timeoutSeconds = Number(draft.timeoutSeconds);

  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 3600
  )
    return { error: "Timeout must be between 1 and 3600 seconds." };

  return { fields: { prompt: "", command: draft.command, timeoutSeconds } };
}

type Trigger = Pick<AutomationBody, "cron" | "runAt" | "eventSourceId">;

function triggerFields(
  draft: AutomationDraft,
  timezone: string,
): { error: string } | { trigger: Trigger } {
  if (draft.onEvent)
    return {
      trigger: { cron: null, runAt: null, eventSourceId: draft.eventSourceId },
    };

  if (draft.repeat)
    return {
      trigger: { cron: draft.cron.trim(), runAt: null, eventSourceId: null },
    };

  const instant = fromWallClock(draft.runAt, timezone);

  return instant
    ? {
        trigger: {
          cron: null,
          runAt: instant.toISOString(),
          eventSourceId: null,
        },
      }
    : { error: "Choose a valid date and time." };
}

function automationBody(
  draft: AutomationDraft,
): { error: string } | { body: AutomationBody } {
  const content = kindFields(draft);

  if ("error" in content) return content;

  const error = runTimeError(draft);

  if (error) return { error };

  const timezone = draft.timezone.trim();
  const when = triggerFields(draft, timezone);

  if ("error" in when) return when;

  return {
    body: {
      agentId: draft.agentId,
      name: draft.name.trim(),
      ...content.fields,
      kind: draft.kind,
      notify: draft.notify,
      timezone,
      enabled: draft.enabled,
      ...when.trigger,
    },
  };
}

function useSaveAutomation(schedule: Schedule | null, onClose: () => void) {
  return useMutation({
    mutationFn: (body: AutomationBody) =>
      schedule
        ? send(
            `/v1/schedules/${encodeURIComponent(schedule.id)}`,
            "PATCH",
            body,
          )
        : send("/v1/schedules", "POST", {
            ...body,
            cron: body.cron ?? undefined,
            runAt: body.runAt ?? undefined,
            eventSourceId: body.eventSourceId ?? undefined,
          }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
}

function AutomationDialog({
  bots,
  editing,
  onClose,
}: {
  bots: Bot[];
  editing: Editing;
  onClose: () => void;
}) {
  const initial = editing.schedule;
  const [draft, setDraft] = useState(() => initialDraft(editing));
  const [error, setError] = useState<string | null>(null);
  const save = useSaveAutomation(initial, onClose);

  const patch = (change: Partial<AutomationDraft>) =>
    setDraft((current) => ({ ...current, ...change }));

  const submit = () => {
    setError(null);

    const result = automationBody(draft);

    if ("error" in result) return setError(result.error);

    save.mutate(result.body);
  };

  const failure = error ?? save.error?.message;

  return (
    <EditorSheet
      title={initial ? "Edit Automation" : "New Automation"}
      description="The bot gets this at the time you choose and answers in its chat."
      error={failure}
      submitLabel={initial ? "Save" : "Create"}
      submitDisabled={save.isPending}
      onSubmit={submit}
      onClose={onClose}
    >
      <AutomationFields
        bots={bots}
        draft={draft}
        patch={patch}
        editingScript={initial?.kind === "script"}
      />
    </EditorSheet>
  );
}

function ScriptFields({
  draft,
  patch,
}: {
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
}) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="automation-command">Command</FieldLabel>
        <Textarea
          id="automation-command"
          className="min-h-28 font-mono"
          placeholder="./scripts/backup.sh"
          maxLength={8000}
          value={draft.command}
          onChange={(event) => patch({ command: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="automation-timeout">Timeout (seconds)</FieldLabel>
        <Input
          id="automation-timeout"
          type="number"
          required
          min={1}
          max={3600}
          step={1}
          value={draft.timeoutSeconds}
          onChange={(event) => patch({ timeoutSeconds: event.target.value })}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="automation-notify">
            Send results to the chat
          </FieldLabel>
          <FieldDescription>
            Each finished run posts its output to the bot's chat.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="automation-notify"
          checked={draft.notify}
          onCheckedChange={(notify) => patch({ notify })}
        />
      </Field>
    </>
  );
}

/** A cron the schedule picker can show without cron syntax; anything else is custom. */
type Recurrence =
  | { kind: "hourly"; minute: number }
  | { kind: "daily" | "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; days: number[]; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number };

const KINDS = ["hourly", "daily", "weekdays", "weekly", "monthly"] as const;

const REPEATS = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom" },
];

type RepeatKind = Recurrence["kind"] | "custom";

// Monday first; cron counts Sunday as 0.
const WEEK = [1, 2, 3, 4, 5, 6, 0];

const weekdayName = (day: number, weekday: "short" | "long") =>
  // 2023-01-01 was a Sunday, so day n is n days later.
  new Date(2023, 0, 1 + day).toLocaleDateString(undefined, { weekday });

const time = (match: RegExpExecArray) => ({
  minute: Number(match[1]),
  hour: Number(match[2]),
});

// The crons the schedule picker shows in words, by their fields.
const WORDED_CRONS: [RegExp, (match: RegExpExecArray) => Recurrence][] = [
  [
    /^(\d+) \* \* \* \*$/,
    (match) => ({ kind: "hourly", minute: Number(match[1]) }),
  ],
  [/^(\d+) (\d+) \* \* \*$/, (match) => ({ kind: "daily", ...time(match) })],
  [
    /^(\d+) (\d+) \* \* 1-5$/,
    (match) => ({ kind: "weekdays", ...time(match) }),
  ],
  [
    /^(\d+) (\d+) \* \* ([0-7](?:,[0-7])*)$/,
    (match) => ({
      kind: "weekly",
      days: [
        ...new Set((match[3] ?? "").split(",").map((day) => Number(day) % 7)),
      ],
      ...time(match),
    }),
  ],
  [
    /^(\d+) (\d+) (\d+) \* \*$/,
    (match) => ({
      kind: "monthly",
      minute: Number(match[1]),
      hour: Number(match[2]),
      day: Number(match[3]),
    }),
  ],
];

const inBounds = (recurrence: Recurrence) =>
  recurrence.minute <= 59 &&
  (!("hour" in recurrence) || recurrence.hour <= 23) &&
  (recurrence.kind !== "monthly" ||
    (recurrence.day >= 1 && recurrence.day <= 31));

function recurrenceOf(cron: string): Recurrence | null {
  const text = cron.trim().replace(/\s+/g, " ");

  for (const [pattern, build] of WORDED_CRONS) {
    const match = pattern.exec(text);

    if (match) return inBounds(build(match)) ? build(match) : null;
  }

  return null;
}

function cronOf(recurrence: Recurrence) {
  if (recurrence.kind === "hourly") return `${recurrence.minute} * * * *`;

  const { minute, hour } = recurrence;

  switch (recurrence.kind) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${[...recurrence.days].sort((a, b) => a - b).join(",")}`;
    case "monthly":
      return `${minute} ${hour} ${recurrence.day} * *`;
  }
}

/** Every setting a recurrence can carry, so switching kinds keeps what was chosen. */
type RecurrenceSettings = {
  hour: number;
  minute: number;
  days: number[];
  day: number;
};

/** The recurrence `kind` turns into, keeping what the current one already set. */
function switchedTo(
  kind: Recurrence["kind"],
  current: Recurrence | null,
): Recurrence {
  const kept: RecurrenceSettings = {
    hour: 9,
    minute: 0,
    days: [1],
    day: 1,
    ...current,
  };

  const { hour, minute } = kept;

  switch (kind) {
    case "hourly":
      return { kind, minute };
    case "weekly":
      return { kind, days: kept.days, hour, minute };
    case "monthly":
      return { kind, day: kept.day, hour, minute };
    default:
      return { kind, hour, minute };
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

type When = "once" | RepeatKind;

const WHEN = [
  { value: "once", label: "Once" },
  ...REPEATS.map((item) =>
    item.value === "custom" ? { ...item, label: "Custom (cron)" } : item,
  ),
];

const MINUTES = Array.from({ length: 12 }, (_, index) => ({
  value: String(index * 5),
  label: `:${pad(index * 5)}`,
}));

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
}));

/** The five-minute grid, plus the current minute when it falls between. */
const minuteItems = (minute: number) =>
  minute % 5
    ? [...MINUTES, { value: String(minute), label: `:${pad(minute)}` }].sort(
        (a, b) => Number(a.value) - Number(b.value),
      )
    : MINUTES;

function InlineSelect({
  label,
  value,
  items,
  className,
  onChange,
}: {
  label: string;
  value: string;
  items: { value: string; label: string }[];
  className?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => next && onChange(next)}
    >
      <SelectTrigger aria-label={label} className={cn("w-auto", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectOptions items={items} />
    </Select>
  );
}

const Word = ({ children }: { children: ReactNode }) => (
  <span className="text-sm text-muted-foreground">{children}</span>
);

function TimeInput({
  recurrence,
  onChange,
}: {
  recurrence: Exclude<Recurrence, { kind: "hourly" }>;
  onChange: (next: Recurrence) => void;
}) {
  return (
    <Input
      type="time"
      aria-label="Time"
      required
      className="w-auto"
      value={`${pad(recurrence.hour)}:${pad(recurrence.minute)}`}
      onChange={(event) => {
        const [hour, minute] = event.target.value.split(":").map(Number);

        if (hour === undefined || minute === undefined) return;

        onChange({ ...recurrence, hour, minute });
      }}
    />
  );
}

function WeekdayToggles({
  days,
  onChange,
}: {
  days: number[];
  onChange: (days: number[]) => void;
}) {
  return (
    <div
      className="grid w-full grid-cols-7 gap-1"
      role="group"
      aria-label="Days"
    >
      {WEEK.map((day) => {
        const on = days.includes(day);

        return (
          <Button
            key={day}
            type="button"
            size="sm"
            variant={on ? "default" : "outline"}
            aria-pressed={on}
            title={weekdayName(day, "long")}
            // A week needs at least one day.
            disabled={on && days.length === 1}
            onClick={() =>
              onChange(
                on ? days.filter((each) => each !== day) : [...days, day],
              )
            }
          >
            {weekdayName(day, "short")}
          </Button>
        );
      })}
    </div>
  );
}

/** The rest of the sentence after the When choice, laid out inline. */
function RecurrenceParts({
  recurrence,
  onChange,
}: {
  recurrence: Recurrence;
  onChange: (next: Recurrence) => void;
}) {
  if (recurrence.kind === "hourly")
    return (
      <>
        <Word>at</Word>
        <InlineSelect
          label="Minute"
          value={String(recurrence.minute)}
          items={minuteItems(recurrence.minute)}
          onChange={(minute) =>
            onChange({ ...recurrence, minute: Number(minute) })
          }
        />
      </>
    );

  return (
    <>
      {recurrence.kind === "weekly" && (
        <>
          <Word>on</Word>
          <WeekdayToggles
            days={recurrence.days}
            onChange={(days) => onChange({ ...recurrence, days })}
          />
        </>
      )}
      {recurrence.kind === "monthly" && (
        <>
          <Word>on day</Word>
          <InlineSelect
            label="Day of the month"
            value={String(recurrence.day)}
            items={MONTH_DAYS}
            onChange={(day) => onChange({ ...recurrence, day: Number(day) })}
          />
        </>
      )}
      <Word>at</Word>
      <TimeInput recurrence={recurrence} onChange={onChange} />
    </>
  );
}

/** When the draft runs next, by the scheduler's own cron parser; null when it cannot run. */
function nextRun(draft: AutomationDraft) {
  const zone = draft.timezone.trim();

  if (!validZone(zone)) return null;

  if (!draft.repeat) return fromWallClock(draft.runAt, zone);

  try {
    return CronExpressionParser.parse(draft.cron, {
      currentDate: new Date(),
      tz: zone,
    })
      .next()
      .toDate();
  } catch {
    return null;
  }
}

/** "today at 09:00", "Thursday at 09:00", or "Mon, 9 Nov at 09:00", on the clock of `zone`. */
function humanRun(date: Date, zone: string, now: Date) {
  const day = (value: Date) => Date.parse(wallClock(value, zone).slice(0, 10));
  const days = Math.round((day(date) - day(now)) / 86_400_000);

  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  });

  const on =
    days >= 0 && days < 2
      ? relative.format(days, "day")
      : date.toLocaleDateString(
          undefined,
          days > 0 && days < 7
            ? { weekday: "long", timeZone: zone }
            : {
                weekday: "short",
                day: "numeric",
                month: "short",
                timeZone: zone,
              },
        );

  return `${on} at ${time}`;
}

function NextRun({ draft }: { draft: AutomationDraft }) {
  const run = nextRun(draft);
  const zone = draft.timezone.trim();

  const now = new Date();

  if (!run)
    return (
      <p className="text-sm text-destructive">This schedule never runs.</p>
    );

  if (run < now)
    return <p className="text-sm text-destructive">This time has passed.</p>;

  return (
    <p className="text-sm text-muted-foreground">
      {draft.repeat ? "Next run" : "Runs"}{" "}
      <span className="font-medium text-foreground">
        {humanRun(run, zone, now)}
      </span>{" "}
      ({zone})
    </p>
  );
}

function BotPicker({
  bots,
  draft,
  patch,
  canCode,
}: {
  bots: Bot[];
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
  canCode: (agentId: string) => boolean;
}) {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const items = bots.map((bot) => ({ label: bot.name, value: bot.id }));

  return (
    <Field>
      <FieldLabel>Runs on</FieldLabel>
      <Select
        items={items}
        value={draft.agentId}
        onValueChange={(value) => {
          if (!value) return;

          patch({
            agentId: value,
            kind: canCode(value) ? draft.kind : "prompt",
          });
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue>
            {(value: string) => {
              const bot = byId.get(value);

              return bot ? <BotChoice bot={bot} /> : null;
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {bots.map((bot) => (
              <SelectItem key={bot.id} value={bot.id}>
                <BotChoice bot={bot} />
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function BotChoice({ bot }: { bot: Bot }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <BotAvatar bot={bot} size={20} />
      <span className="truncate">{bot.name}</span>
    </span>
  );
}

const whenOf = (
  draft: AutomationDraft,
  custom: boolean,
  recurrence: Recurrence | null,
): When => {
  if (!draft.repeat) return "once";

  return custom || !recurrence ? "custom" : recurrence.kind;
};

/** The draft change for a When choice, keeping the current time where it can. */
function whenPatch(
  value: string,
  recurrence: Recurrence | null,
): Partial<AutomationDraft> {
  if (value === "once") return { onEvent: false, repeat: false };

  const picked = KINDS.find((each) => each === value);

  return picked
    ? {
        onEvent: false,
        repeat: true,
        cron: cronOf(switchedTo(picked, recurrence)),
      }
    : { onEvent: false, repeat: true };
}

function WhenDetails({
  when,
  draft,
  recurrence,
  patch,
}: {
  when: When;
  draft: AutomationDraft;
  recurrence: Recurrence | null;
  patch: (change: Partial<AutomationDraft>) => void;
}) {
  if (when === "once")
    return (
      <Input
        type="datetime-local"
        aria-label="Date and time"
        className="w-auto"
        value={draft.runAt}
        onChange={(event) => patch({ runAt: event.target.value })}
      />
    );

  if (when === "custom" || !recurrence) return null;

  return (
    <RecurrenceParts
      recurrence={recurrence}
      onChange={(next) => patch({ repeat: true, cron: cronOf(next) })}
    />
  );
}

function EventSourcePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (eventSourceId: string) => void;
}) {
  const sources = useQuery(eventSourcesQuery);

  if (sources.data?.length === 0)
    return (
      <span className="text-sm text-muted-foreground">
        Add a source in{" "}
        <Link to="/settings/event-relay" className="underline">
          Settings › Event relay
        </Link>{" "}
        first.
      </span>
    );

  return (
    <InlineSelect
      label="Event source"
      value={value}
      items={[
        ...(value ? [] : [{ value: "", label: "Choose a source" }]),
        ...(sources.data ?? []).map((source) => ({
          value: source.id,
          label: source.name,
        })),
      ]}
      onChange={onChange}
    />
  );
}

function CronField({
  draft,
  patch,
}: {
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
}) {
  return (
    <Field>
      <Input
        aria-label="Cron"
        className="font-mono"
        placeholder="0 9 * * 1-5"
        maxLength={100}
        value={draft.cron}
        onChange={(event) => patch({ cron: event.target.value })}
      />
      <FieldDescription>
        {describeCron(draft.cron, draft.timezone.trim())}
      </FieldDescription>
    </Field>
  );
}

function TimeFields({
  draft,
  patch,
}: {
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
}) {
  const recurrence = recurrenceOf(draft.cron);
  // Custom stays chosen even when the typed cron happens to fit a simple shape.
  const [custom, setCustom] = useState(draft.repeat && recurrence === null);
  const when = whenOf(draft, custom, recurrence);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <InlineSelect
          label="When"
          value={when}
          items={WHEN}
          onChange={(value) => {
            setCustom(value === "custom");
            patch(whenPatch(value, recurrence));
          }}
        />
        <WhenDetails
          when={when}
          draft={draft}
          recurrence={recurrence}
          patch={patch}
        />
      </div>
      {when === "custom" && <CronField draft={draft} patch={patch} />}
      <NextRun draft={draft} />
    </>
  );
}

function EventFields({
  draft,
  patch,
}: {
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
}) {
  return (
    <Field>
      <FieldLabel>Event source</FieldLabel>
      <EventSourcePicker
        value={draft.eventSourceId}
        onChange={(eventSourceId) => patch({ eventSourceId })}
      />
    </Field>
  );
}

function ScheduleFields({
  draft,
  patch,
}: {
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
}) {
  return (
    <>
      <Tabs
        value={draft.onEvent ? "event" : "time"}
        onValueChange={(value) => patch({ onEvent: value === "event" })}
      >
        <TabsList aria-label="Trigger" className="w-full">
          <TabsTrigger value="time">
            <IconClock data-icon="inline-start" />
            Time
          </TabsTrigger>
          <TabsTrigger value="event">
            <IconWebhook data-icon="inline-start" />
            Event
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {draft.onEvent ? (
        <EventFields draft={draft} patch={patch} />
      ) : (
        <TimeFields draft={draft} patch={patch} />
      )}
    </>
  );
}

function AutomationFields({
  bots,
  draft,
  patch,
  editingScript,
}: {
  bots: Bot[];
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
  editingScript: boolean;
}) {
  const capabilities = useQuery(capabilitiesQuery).data;

  const canCode = (agentId: string) =>
    capabilities?.coding === true &&
    bots.some((bot) => bot.id === agentId && bot.tools.includes("coding"));

  const canScript = canCode(draft.agentId);

  return (
    <>
      <EditorSection title="Automation">
        <Field>
          <FieldLabel htmlFor="automation-name">Name</FieldLabel>
          <Input
            id="automation-name"
            placeholder="Morning inbox triage"
            maxLength={200}
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>
        <BotPicker bots={bots} draft={draft} patch={patch} canCode={canCode} />
        {(canScript || editingScript) && (
          <Tabs
            value={draft.kind}
            onValueChange={(value) =>
              patch({ kind: value === "script" ? "script" : "prompt" })
            }
          >
            <TabsList aria-label="Automation kind" className="w-full">
              <TabsTrigger value="prompt">
                <IconMessage data-icon="inline-start" />
                Prompt
              </TabsTrigger>
              <TabsTrigger value="script" disabled={!canScript}>
                <IconTerminal2 data-icon="inline-start" />
                Script
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {draft.kind === "script" ? (
          <ScriptFields draft={draft} patch={patch} />
        ) : (
          <Field>
            <FieldLabel htmlFor="automation-prompt">Prompt</FieldLabel>
            <Textarea
              id="automation-prompt"
              className="min-h-28"
              placeholder="Summarize my unread email and flag anything urgent."
              maxLength={32000}
              value={draft.prompt}
              onChange={(event) => patch({ prompt: event.target.value })}
            />
          </Field>
        )}
      </EditorSection>
      <EditorSection title="When">
        <ScheduleFields draft={draft} patch={patch} />
      </EditorSection>
      <EditorSection>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="automation-enabled">Enabled</FieldLabel>
          </FieldContent>
          <Switch
            id="automation-enabled"
            checked={draft.enabled}
            onCheckedChange={(enabled) => patch({ enabled })}
          />
        </Field>
      </EditorSection>
    </>
  );
}
