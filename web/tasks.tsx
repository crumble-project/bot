import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
  botsQuery,
  call,
  queryClient,
  schedulesQuery,
  send,
} from "./api";
import { BotAvatar } from "./avatar";
import { ConfirmDelete, Section, WorkspacePage } from "./workspace";

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function clock(hour: string, minute: string) {
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

/** Describes common cron shapes in words, like the Mac app; anything else stays as written. */
export function describeCron(cron: string, timezone: string) {
  const [minute, hour, dayOfMonth, month, weekday, ...rest] = cron
    .trim()
    .split(/\s+/);

  const zone = timezone !== LOCAL_ZONE ? ` (${timezone})` : "";
  const number = /^\d+$/;

  if (rest.length || !minute || !hour || month !== "*") return `${cron}${zone}`;

  if (dayOfMonth !== "*") {
    if (
      !dayOfMonth ||
      !number.test(dayOfMonth) ||
      !number.test(minute) ||
      !number.test(hour) ||
      weekday !== "*"
    )
      return `${cron}${zone}`;

    return `Monthly on day ${dayOfMonth} at ${clock(hour, minute)}${zone}`;
  }

  const every = /^\*\/(\d+)$/.exec(minute);

  if (every && hour === "*" && weekday === "*")
    return `Every ${every[1]} minutes`;

  if (number.test(minute) && hour === "*" && weekday === "*")
    return `Every hour at :${minute.padStart(2, "0")}`;

  if (!number.test(minute) || !number.test(hour)) return `${cron}${zone}`;

  const at = `at ${clock(hour, minute)}${zone}`;

  if (weekday === "*") return `Every day ${at}`;

  if (weekday === "1-5") return `Weekdays ${at}`;

  if (weekday === "0,6" || weekday === "6,0") return `Weekends ${at}`;

  if (weekday && /^[0-7]$/.test(weekday))
    return `Every ${DAYS[Number(weekday) % 7]} ${at}`;

  return `${cron}${zone}`;
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

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
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

export function TasksPage() {
  const bots = useQuery(botsQuery);
  const schedules = useQuery(schedulesQuery);
  const [editing, setEditing] = useState<Editing | null>(null);
  const firstBot = bots.data?.[0];
  const now = new Date();
  const byId = new Map(bots.data?.map((bot) => [bot.id, bot]));
  const shown = schedules.data?.filter((schedule) => !finished(schedule));

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
      {bots.isPending || schedules.isPending ? (
        <Skeleton className="h-40" />
      ) : schedules.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{schedules.error.message}</AlertDescription>
        </Alert>
      ) : !shown?.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle className="font-heading text-lg">
              No tasks yet
            </EmptyTitle>
            <EmptyDescription>
              {firstBot
                ? "A task sends a bot a message once or on a schedule, and the bot answers in its chat."
                : "Create a bot, then give it a task to run once or on a schedule."}
            </EmptyDescription>
          </EmptyHeader>
          {firstBot && (
            <EmptyContent>
              <Button onClick={create}>
                <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
                New task
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        agendaOf(shown, now).map((group) => (
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
                  onEdit={() =>
                    setEditing({ schedule, agentId: schedule.agentId })
                  }
                />
              ) : null;
            })}
          </Section>
        ))
      )}
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

function TaskRow({
  schedule,
  bot,
  creator,
  now,
  onEdit,
}: {
  schedule: Schedule;
  bot: Bot;
  creator?: Bot;
  /** Set for upcoming tasks, which lead with when they run next. */
  now?: Date;
  onEdit: () => void;
}) {
  const navigate = useNavigate();
  const path = `/v1/schedules/${encodeURIComponent(schedule.id)}`;
  const next = now && schedule.nextRunAt ? new Date(schedule.nextRunAt) : null;

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

  const failure = toggle.error ?? run.error ?? remove.error;

  return (
    <div className="group/task flex items-center gap-3 p-3">
      {now && (
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
      )}
      <BotAvatar
        bot={bot}
        size={32}
        state={schedule.enabled ? "idle" : "sleeping"}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{schedule.name}</span>
        <p className="line-clamp-1 text-sm text-muted-foreground">
          {schedule.prompt}
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
      <Switch
        aria-label={schedule.enabled ? "Pause task" : "Resume task"}
        checked={toggle.isPending ? toggle.variables : schedule.enabled}
        disabled={toggle.isPending}
        onCheckedChange={(enabled) => toggle.mutate(enabled)}
      />
    </div>
  );
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
  const [agentId, setAgentId] = useState(editing.agentId);
  const [name, setName] = useState(initial?.name ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [repeat, setRepeat] = useState(initial ? initial.cron !== null : false);
  const [cron, setCron] = useState(initial?.cron ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(initial?.timezone ?? LOCAL_ZONE);
  const [error, setError] = useState<string | null>(null);

  const [runAt, setRunAt] = useState(() =>
    initial?.runAt
      ? wallClock(new Date(initial.runAt), initial.timezone)
      : inOneHour(initial?.timezone ?? LOCAL_ZONE),
  );

  const botItems = bots.map((bot) => ({ label: bot.name, value: bot.id }));

  const save = useMutation({
    mutationFn: (body: {
      agentId: string;
      name: string;
      prompt: string;
      timezone: string;
      enabled: boolean;
      cron: string | null;
      runAt: string | null;
    }) =>
      initial
        ? send(`/v1/schedules/${encodeURIComponent(initial.id)}`, "PATCH", body)
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

  const submit = () => {
    setError(null);

    if (!name.trim() || !prompt.trim())
      return setError("Task name and prompt are required.");

    if (repeat ? !cron.trim() : !runAt)
      return setError("Choose either a recurring cron or a one-time run time.");

    if (!validZone(timezone.trim()))
      return setError("Choose a valid time zone.");

    const instant = repeat ? null : fromWallClock(runAt, timezone.trim());

    if (!repeat && !instant) return setError("Choose a valid date and time.");

    save.mutate({
      agentId,
      name: name.trim(),
      prompt: prompt.trim(),
      timezone: timezone.trim(),
      enabled,
      cron: repeat ? cron.trim() : null,
      runAt: instant?.toISOString() ?? null,
    });
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
            <Field>
              <FieldLabel>Runs on</FieldLabel>
              <Select
                items={botItems}
                value={agentId}
                onValueChange={(value) => value && setAgentId(value)}
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
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="task-prompt">Prompt</FieldLabel>
              <Textarea
                id="task-prompt"
                className="min-h-24"
                maxLength={32000}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Frequency</FieldLabel>
              <Tabs
                value={repeat ? "repeat" : "once"}
                onValueChange={(value: string) => setRepeat(value === "repeat")}
              >
                <TabsList>
                  <TabsTrigger value="once">Run once</TabsTrigger>
                  <TabsTrigger value="repeat">Repeat</TabsTrigger>
                </TabsList>
              </Tabs>
            </Field>
            {repeat ? (
              <Field>
                <FieldLabel htmlFor="task-cron">Cron</FieldLabel>
                <Input
                  id="task-cron"
                  className="font-mono"
                  maxLength={100}
                  value={cron}
                  onChange={(event) => setCron(event.target.value)}
                />
                <FieldDescription>
                  {describeCron(cron, timezone.trim())}
                </FieldDescription>
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor="task-run-at">Date and time</FieldLabel>
                <Input
                  id="task-run-at"
                  type="datetime-local"
                  value={runAt}
                  onChange={(event) => setRunAt(event.target.value)}
                />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="task-zone">Time zone</FieldLabel>
              <Input
                id="task-zone"
                maxLength={100}
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="task-enabled">Enabled</FieldLabel>
              </FieldContent>
              <Switch
                id="task-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </Field>
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
