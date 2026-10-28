import { useState } from "react";
import cronstrue from "cronstrue";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  PencilEdit01Icon,
  PlayIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  FieldGroup,
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type Bot,
  type Schedule,
  type ScriptRun,
  botsQuery,
  call,
  capabilitiesQuery,
  queryClient,
  schedulesQuery,
  scriptRunsQuery,
  send,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { BotAvatar } from "@/features/bots/avatar";
import { ConfirmDelete, Section, WorkspacePage } from "@/components/workspace";

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

export function describeTiming(schedule: Schedule) {
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

/** A task's timing as the Mac app shows it, prefixed "Paused · " when disabled. */
export function taskTiming(schedule: Schedule) {
  return `${schedule.enabled ? "" : "Paused · "}${describeTiming(schedule)}`;
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

/** A one-off task that already ran; its result is in the bot's chat. */
export const finished = (schedule: Schedule) =>
  !schedule.cron && !schedule.nextRunAt;

/** Upcoming tasks by the day they next run, then paused ones. */
function agendaOf(schedules: Schedule[], now: Date) {
  const upcoming = schedules
    .filter((schedule) => schedule.enabled && schedule.nextRunAt)
    .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!));

  const days = new Map<string, Schedule[]>();

  for (const schedule of upcoming) {
    const label = dayLabel(new Date(schedule.nextRunAt!), now);

    days.set(label, [...(days.get(label) ?? []), schedule]);
  }

  return [
    ...[...days].map(([title, list]) => ({ title, list, upcoming: true })),
    {
      title: "Paused",
      list: schedules.filter(
        (schedule) => !schedule.enabled && !finished(schedule),
      ),
      upcoming: false,
    },
    {
      title: "Completed",
      list: schedules.filter(
        (schedule) => schedule.kind === "script" && finished(schedule),
      ),
      upcoming: false,
    },
  ].filter((group) => group.list.length > 0);
}

function dayLabel(date: Date, now: Date) {
  const midnight = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();

  const days = Math.round((midnight(date) - midnight(now)) / 86_400_000);

  if (days <= 0) return "Today";

  if (days === 1) return "Tomorrow";

  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** How soon a run starts, for runs within the next day. */
function soon(date: Date, now: Date) {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000);

  if (minutes < 60) return relative.format(Math.max(minutes, 0), "minute");

  return relative.format(Math.round(minutes / 60), "hour");
}

function TasksEmpty({
  firstBot,
  onCreate,
}: {
  firstBot?: Bot | undefined;
  onCreate: () => void;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle className="font-heading text-lg">No tasks yet</EmptyTitle>
        <EmptyDescription>
          {firstBot
            ? "A task sends a bot a message once or on a schedule, and the bot answers in its chat."
            : "Create a bot, then give it a task to run once or on a schedule."}
        </EmptyDescription>
      </EmptyHeader>
      {firstBot && (
        <EmptyContent>
          <Button onClick={onCreate}>
            <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
            New task
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

function Agenda({
  shown,
  byId,
  onEdit,
}: {
  shown: Schedule[];
  byId: Map<string, Bot>;
  onEdit: (schedule: Schedule) => void;
}) {
  const now = new Date();

  return agendaOf(shown, now).map((group) => (
    <Section key={group.title} title={group.title}>
      {group.list.map((schedule) => {
        const bot = byId.get(schedule.agentId);

        return bot ? (
          <TaskRow
            key={schedule.id}
            schedule={schedule}
            bot={bot}
            creator={
              schedule.createdByAgentId &&
              schedule.createdByAgentId !== schedule.agentId
                ? byId.get(schedule.createdByAgentId)
                : undefined
            }
            now={group.upcoming ? now : undefined}
            onEdit={() => onEdit(schedule)}
          />
        ) : null;
      })}
    </Section>
  ));
}

function TasksBody({
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

  const shown = schedules.data?.filter(
    (schedule) => schedule.kind === "script" || !finished(schedule),
  );

  if (bots.isPending || schedules.isPending)
    return <Skeleton className="h-40" />;

  if (schedules.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{schedules.error.message}</AlertDescription>
      </Alert>
    );

  if (!shown?.length)
    return <TasksEmpty firstBot={firstBot} onCreate={onCreate} />;

  return <Agenda shown={shown} byId={byId} onEdit={onEdit} />;
}

export function TasksPage() {
  const bots = useQuery(botsQuery);
  const schedules = useQuery(schedulesQuery);
  const [editing, setEditing] = useState<Editing | null>(null);
  const firstBot = bots.data?.[0];

  const create = () =>
    firstBot && setEditing({ schedule: null, agentId: firstBot.id });

  return (
    <WorkspacePage
      title="Tasks"
      refreshing={bots.isFetching || schedules.isFetching}
      onRefresh={() => {
        void schedules.refetch();
        void bots.refetch();
      }}
      newLabel="New task"
      newDisabled={!firstBot}
      onNew={create}
    >
      <TasksBody
        bots={bots}
        schedules={schedules}
        onCreate={create}
        onEdit={(schedule) =>
          setEditing({ schedule, agentId: schedule.agentId })
        }
      />
      {editing && (
        <TaskDialog
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

function useTaskActions(schedule: Schedule) {
  const navigate = useNavigate();
  const path = `/v1/schedules/${encodeURIComponent(schedule.id)}`;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => send(path, "PATCH", { enabled }),
    onSettled: refresh,
  });

  const run = useMutation({
    mutationFn: async () => {
      const result = await call<{ admitted: boolean }>(`${path}/run`, "POST");

      if (!result.admitted) throw new Error("Task could not be started");
    },
    onSuccess: () =>
      navigate({ to: "/bots/$botId", params: { botId: schedule.agentId } }),
  });

  const remove = useMutation({
    mutationFn: () => send(path, "DELETE"),
    onSettled: refresh,
  });

  return { toggle, run, remove };
}

function NextRun({ next, now }: { next: Date | null; now: Date }) {
  return (
    <div className="flex w-16 shrink-0 flex-col tabular-nums">
      {next && (
        <>
          <span className="font-heading text-base font-semibold">
            {next.toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {next.getTime() - now.getTime() < 86_400_000 && (
            <span className="text-xs text-muted-foreground">
              {soon(next, now)}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function TaskSummary({
  schedule,
  bot,
  creator,
  next,
  failure,
}: {
  schedule: Schedule;
  bot: Bot;
  creator?: Bot | undefined;
  next: Date | null;
  failure?: Error | null;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-sm font-medium">{schedule.name}</span>
      <p
        className={cn(
          "line-clamp-1 text-sm text-muted-foreground",
          schedule.kind === "script" && "font-mono",
        )}
      >
        {schedule.kind === "script" ? schedule.command : schedule.prompt}
      </p>
      <span className="truncate text-xs text-muted-foreground">
        {bot.name},{" "}
        {next && !schedule.cron
          ? "once"
          : describeTiming(schedule).replace(/^\w/, (letter) =>
              letter.toLowerCase(),
            )}
        {creator && `, scheduled by ${creator.name}`}
      </span>
      {failure && (
        <span className="text-xs text-destructive">{failure.message}</span>
      )}
    </div>
  );
}

function TaskControls({
  schedule,
  actions,
  onEdit,
}: {
  schedule: Schedule;
  actions: ReturnType<typeof useTaskActions>;
  onEdit: () => void;
}) {
  const { run, remove } = actions;

  return (
    <div className="flex gap-1 opacity-0 transition-opacity group-hover/task:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
      <Button
        variant="ghost"
        size="icon-sm"
        title="Run now"
        disabled={!schedule.enabled || run.isPending}
        onClick={() => run.mutate()}
      >
        <HugeiconsIcon icon={PlayIcon} />
      </Button>
      <Button variant="ghost" size="icon-sm" title="Edit" onClick={onEdit}>
        <HugeiconsIcon icon={PencilEdit01Icon} />
      </Button>
      <ConfirmDelete
        title={`Delete ${schedule.name}?`}
        description="The task stops running. This cannot be undone."
        onConfirm={() => remove.mutate()}
        trigger={
          <Button variant="ghost" size="icon-sm" title="Delete">
            <HugeiconsIcon icon={Delete02Icon} />
          </Button>
        }
      />
    </div>
  );
}

function TaskToggle({
  schedule,
  toggle,
}: {
  schedule: Schedule;
  toggle: ReturnType<typeof useTaskActions>["toggle"];
}) {
  return (
    <Switch
      aria-label={schedule.enabled ? "Pause task" : "Resume task"}
      checked={toggle.isPending ? toggle.variables : schedule.enabled}
      disabled={toggle.isPending}
      onCheckedChange={(enabled) => toggle.mutate(enabled)}
    />
  );
}

function TaskRow({
  schedule,
  bot,
  creator,
  now,
  onEdit,
}: {
  schedule: Schedule;
  bot: Bot;
  creator?: Bot | undefined;
  /** Set for upcoming tasks, which lead with when they run next. */
  now?: Date | undefined;
  onEdit: () => void;
}) {
  const next = now && schedule.nextRunAt ? new Date(schedule.nextRunAt) : null;
  const actions = useTaskActions(schedule);
  const { toggle, run, remove } = actions;

  return (
    <div className="group/task min-w-0">
      <div className="flex items-center gap-3 p-3">
        {now && <NextRun next={next} now={now} />}
        <BotAvatar
          bot={bot}
          size={32}
          state={schedule.enabled ? "idle" : "sleeping"}
        />
        <TaskSummary
          schedule={schedule}
          bot={bot}
          creator={creator}
          next={next}
          failure={toggle.error ?? run.error ?? remove.error}
        />
        <TaskControls schedule={schedule} actions={actions} onEdit={onEdit} />
        <TaskToggle schedule={schedule} toggle={toggle} />
      </div>
      {schedule.kind === "script" && <TaskRuns scheduleId={schedule.id} />}
    </div>
  );
}

function runDuration(run: ScriptRun) {
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();

  return `${Math.max(0, (end - Date.parse(run.startedAt)) / 1000).toFixed(1)} s`;
}

function RunDetails({ run }: { run: ScriptRun }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 py-2 text-xs">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        <span>{run.status.replaceAll("_", " ")}</span>
        <span>Exit code: {run.exitCode ?? "—"}</span>
        <time dateTime={run.startedAt}>
          {new Date(run.startedAt).toLocaleString()}
        </time>
        <span>Duration: {runDuration(run)}</span>
      </div>
      {run.error && <p className="text-destructive">{run.error}</p>}
      <details>
        <summary className="cursor-pointer">Output</summary>
        {run.droppedBytes > 0 && (
          <p className="py-1 text-muted-foreground">
            {run.droppedBytes} bytes omitted
          </p>
        )}
        <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono whitespace-pre-wrap break-all">
          {run.output || "No output"}
        </pre>
      </details>
    </div>
  );
}

function TaskRuns({ scheduleId }: { scheduleId: string }) {
  const [open, setOpen] = useState(false);

  const runs = useQuery({
    ...scriptRunsQuery(scheduleId),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });

  return (
    <div className="min-w-0 px-3 pb-3">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Runs
      </Button>
      {open && (
        <div className="flex min-w-0 flex-col gap-2">
          {runs.isPending && <Skeleton className="h-12" />}
          {runs.isError && (
            <Alert variant="destructive">
              <AlertDescription>{runs.error.message}</AlertDescription>
            </Alert>
          )}
          {runs.data?.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No runs yet</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
          {runs.data?.map((run) => (
            <RunDetails key={run.id} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}

type TaskDraft = {
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
};

type TaskBody = {
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
};

const DEFAULT_CRON = "0 9 * * *";

function blankDraft(agentId: string): TaskDraft {
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
  };
}

function draftOf(agentId: string, schedule: Schedule): TaskDraft {
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
  };
}

function initialDraft(editing: Editing) {
  return editing.schedule
    ? draftOf(editing.agentId, editing.schedule)
    : blankDraft(editing.agentId);
}

function runTimeError(draft: TaskDraft) {
  if (draft.repeat ? !draft.cron.trim() : !draft.runAt)
    return "Choose either a recurring cron or a one-time run time.";

  if (!validZone(draft.timezone.trim())) return "Choose a valid time zone.";

  return null;
}

function kindFields(
  draft: TaskDraft,
):
  | { error: string }
  | { fields: Pick<TaskBody, "prompt" | "command" | "timeoutSeconds"> } {
  if (draft.kind === "prompt") {
    if (!draft.name.trim() || !draft.prompt.trim())
      return { error: "Task name and prompt are required." };

    return {
      fields: {
        prompt: draft.prompt.trim(),
        command: null,
        timeoutSeconds: 600,
      },
    };
  }

  if (!draft.name.trim() || !draft.command.trim())
    return { error: "Task name and command are required." };

  const timeoutSeconds = Number(draft.timeoutSeconds);

  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 3600
  )
    return { error: "Timeout must be between 1 and 3600 seconds." };

  return { fields: { prompt: "", command: draft.command, timeoutSeconds } };
}

function taskBody(draft: TaskDraft): { error: string } | { body: TaskBody } {
  const content = kindFields(draft);

  if ("error" in content) return content;

  const error = runTimeError(draft);

  if (error) return { error };

  const timezone = draft.timezone.trim();
  const instant = draft.repeat ? null : fromWallClock(draft.runAt, timezone);

  if (!draft.repeat && !instant)
    return { error: "Choose a valid date and time." };

  return {
    body: {
      agentId: draft.agentId,
      name: draft.name.trim(),
      ...content.fields,
      kind: draft.kind,
      notify: draft.notify,
      timezone,
      enabled: draft.enabled,
      cron: draft.repeat ? draft.cron.trim() : null,
      runAt: instant?.toISOString() ?? null,
    },
  };
}

function useSaveTask(schedule: Schedule | null, onClose: () => void) {
  return useMutation({
    mutationFn: (body: TaskBody) =>
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
          }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
}

function TaskDialog({
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
  const save = useSaveTask(initial, onClose);

  const patch = (change: Partial<TaskDraft>) =>
    setDraft((current) => ({ ...current, ...change }));

  const submit = () => {
    setError(null);

    const result = taskBody(draft);

    if ("error" in result) return setError(result.error);

    save.mutate(result.body);
  };

  const failure = error ?? save.error?.message;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit Task" : "New Task"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FieldGroup>
            <TaskFields
              bots={bots}
              draft={draft}
              patch={patch}
              editingScript={initial?.kind === "script"}
            />
            {failure && (
              <Alert variant="destructive">
                <AlertDescription>{failure}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {initial ? "Save" : "Create"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ScriptFields({
  draft,
  patch,
}: {
  draft: TaskDraft;
  patch: (change: Partial<TaskDraft>) => void;
}) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="task-command">Command</FieldLabel>
        <Textarea
          id="task-command"
          className="min-h-24 font-mono"
          maxLength={8000}
          value={draft.command}
          onChange={(event) => patch({ command: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="task-timeout">Timeout (seconds)</FieldLabel>
        <Input
          id="task-timeout"
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
          <FieldLabel htmlFor="task-notify">
            Send results to the chat
          </FieldLabel>
        </FieldContent>
        <Switch
          id="task-notify"
          checked={draft.notify}
          onCheckedChange={(notify) => patch({ notify })}
        />
      </Field>
    </>
  );
}

function TaskFields({
  bots,
  draft,
  patch,
  editingScript,
}: {
  bots: Bot[];
  draft: TaskDraft;
  patch: (change: Partial<TaskDraft>) => void;
  editingScript: boolean;
}) {
  const capabilities = useQuery(capabilitiesQuery).data;

  const canScript =
    capabilities?.coding === true &&
    bots.some(
      (bot) => bot.id === draft.agentId && bot.tools.includes("coding"),
    );

  const botItems = bots.map((bot) => ({ label: bot.name, value: bot.id }));

  return (
    <>
      <Field>
        <FieldLabel>Runs on</FieldLabel>
        <Select
          items={botItems}
          value={draft.agentId}
          onValueChange={(value) => {
            if (!value) return;

            const coding =
              capabilities?.coding === true &&
              bots.some(
                (bot) => bot.id === value && bot.tools.includes("coding"),
              );

            patch({ agentId: value, kind: coding ? draft.kind : "prompt" });
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {botItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="task-name">Name</FieldLabel>
        <Input
          id="task-name"
          maxLength={200}
          value={draft.name}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>
      {(canScript || editingScript) && (
        <Tabs
          value={draft.kind}
          onValueChange={(value) =>
            patch({ kind: value === "script" ? "script" : "prompt" })
          }
        >
          <TabsList aria-label="Task kind">
            <TabsTrigger value="prompt">Prompt</TabsTrigger>
            <TabsTrigger value="script" disabled={!canScript}>
              Script
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {draft.kind === "script" ? (
        <ScriptFields draft={draft} patch={patch} />
      ) : (
        <Field>
          <FieldLabel htmlFor="task-prompt">Prompt</FieldLabel>
          <Textarea
            id="task-prompt"
            className="min-h-24"
            maxLength={32000}
            value={draft.prompt}
            onChange={(event) => patch({ prompt: event.target.value })}
          />
        </Field>
      )}
      <Field>
        <FieldLabel>Frequency</FieldLabel>
        <Tabs
          value={draft.repeat ? "repeat" : "once"}
          onValueChange={(value: string) =>
            patch({ repeat: value === "repeat" })
          }
        >
          <TabsList>
            <TabsTrigger value="once">Run once</TabsTrigger>
            <TabsTrigger value="repeat">Repeat</TabsTrigger>
          </TabsList>
        </Tabs>
      </Field>
      {draft.repeat ? (
        <Field>
          <FieldLabel htmlFor="task-cron">Cron</FieldLabel>
          <Input
            id="task-cron"
            className="font-mono"
            maxLength={100}
            value={draft.cron}
            onChange={(event) => patch({ cron: event.target.value })}
          />
          <FieldDescription>
            {describeCron(draft.cron, draft.timezone.trim())}
          </FieldDescription>
        </Field>
      ) : (
        <Field>
          <FieldLabel htmlFor="task-run-at">Date and time</FieldLabel>
          <Input
            id="task-run-at"
            type="datetime-local"
            value={draft.runAt}
            onChange={(event) => patch({ runAt: event.target.value })}
          />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="task-zone">Time zone</FieldLabel>
        <Input
          id="task-zone"
          maxLength={100}
          value={draft.timezone}
          onChange={(event) => patch({ timezone: event.target.value })}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="task-enabled">Enabled</FieldLabel>
        </FieldContent>
        <Switch
          id="task-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
      </Field>
    </>
  );
}
