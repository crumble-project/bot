import { useState } from "react";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  IconCircleCheck,
  IconCircleCheckFilled,
  IconDots,
  IconPencil,
  IconPlayerPause,
  IconPlayerPauseFilled,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
  type TablerIcon,
} from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BotAvatar } from "@/components/bot-avatar";
import { ConfirmDeleteContent, Page } from "@/components/page";
import { type Bot, botsQuery } from "@/features/bots/api";
import { eventSourcesQuery } from "@/features/event-sources/api";
import { call, queryClient, send } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  type Schedule,
  executionsQuery,
  invalidateSchedules,
  schedulePath,
  schedulesQuery,
  scriptRunsQuery,
  toggleScheduleOptions,
} from "./api";
import { AutomationDialog, type Editing } from "./editor";
import { RunsBody } from "./runs";
import { Heading, TableFrame } from "./table-frame";
import {
  type Status,
  describeTiming,
  finished,
  listed,
  nextRunLabel,
  statusOf,
} from "./timing";

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

type AutomationsView = "automations" | "runs";

function AutomationsToolbar({
  view,
  onView,
  canCreate,
  onCreate,
}: {
  view: AutomationsView;
  onView: (view: AutomationsView) => void;
  canCreate: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Tabs
        value={view}
        onValueChange={(value) =>
          onView(value === "runs" ? "runs" : "automations")
        }
      >
        <TabsList>
          <TabsTrigger value="automations">Automations</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
      </Tabs>
      <Button disabled={!canCreate} onClick={onCreate}>
        <IconPlus data-icon="inline-start" />
        New automation
      </Button>
    </div>
  );
}

export function AutomationsPage() {
  const bots = useQuery(botsQuery);
  const schedules = useQuery(schedulesQuery);
  const executions = useQuery(executionsQuery);
  const [view, setView] = useState<AutomationsView>("automations");
  const [editing, setEditing] = useState<Editing | null>(null);
  const firstBot = bots.data?.[0];

  const create = () =>
    firstBot && setEditing({ schedule: null, agentId: firstBot.id });

  return (
    <Page
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
        <AutomationsToolbar
          view={view}
          onView={setView}
          canCreate={Boolean(firstBot)}
          onCreate={create}
        />
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
    </Page>
  );
}

export function runAutomationOptions(
  schedule: Pick<Schedule, "id">,
  navigate: () => void,
) {
  const path = schedulePath(schedule.id);

  return {
    mutationFn: async () => {
      const result = await call<"runSchedule">(`${path}/run`, "POST");

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
  const path = schedulePath(schedule.id);

  const toggle = useMutation(toggleScheduleOptions(schedule.id));

  const run = useMutation(
    runAutomationOptions(schedule, () => {
      void navigate({
        to: "/bots/$botId",
        params: { botId: schedule.agentId },
      });
    }),
  );

  const remove = useMutation({
    mutationFn: () => send<"deleteSchedule">(path, "DELETE"),
    onSettled: invalidateSchedules,
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
