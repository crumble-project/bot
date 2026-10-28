import {
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  type Bot,
  type Schedule,
  queryClient,
  schedulesQuery,
  send,
} from "@/lib/api";
import { BotAvatar } from "@/features/bots/avatar";
import { DesktopPreview } from "@/features/bot-desktop/desktop";
import { useWorking } from "@/lib/live";
import { automationTiming, finished } from "@/features/schedules/automations";

function Automation({ schedule }: { schedule: Schedule }) {
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      send(`/v1/schedules/${encodeURIComponent(schedule.id)}`, "PATCH", {
        enabled,
      }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: schedulesQuery.queryKey });
      const previous = queryClient.getQueryData(schedulesQuery.queryKey);

      queryClient.setQueryData(schedulesQuery.queryKey, (list?: Schedule[]) =>
        list?.map((each) =>
          each.id === schedule.id ? { ...each, enabled } : each,
        ),
      );

      return previous;
    },
    onError: (_error, _enabled, previous) =>
      queryClient.setQueryData(schedulesQuery.queryKey, previous),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: schedulesQuery.queryKey }),
  });

  return (
    <div className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{schedule.name}</span>
        <span className="text-xs text-muted-foreground">
          {automationTiming(schedule)}
        </span>
      </div>
      <Switch
        size="sm"
        aria-label={`Run ${schedule.name}`}
        checked={schedule.enabled}
        onCheckedChange={(enabled) => toggle.mutate(enabled)}
      />
    </div>
  );
}

function ProfileSummary({ bot, working }: { bot: Bot; working: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <BotAvatar
        bot={bot}
        size={84}
        live
        state={working ? "working" : bot.enabled ? "idle" : "sleeping"}
      />
      <span className="font-medium">{bot.name}</span>
      <span className="text-xs text-muted-foreground">
        {bot.description || (bot.enabled ? "Ready" : "Paused")}
      </span>
    </div>
  );
}

function AutomationList({
  schedules,
  automations,
}: {
  schedules: UseQueryResult<Schedule[]>;
  automations: Schedule[];
}) {
  return (
    <>
      {schedules.isPending && <Skeleton className="h-10" />}
      {automations.map((schedule) => (
        <Automation key={schedule.id} schedule={schedule} />
      ))}
      {schedules.isSuccess && automations.length === 0 && (
        <p className="text-sm text-muted-foreground">No automations yet</p>
      )}
    </>
  );
}

/** The bot inspector beside its chat: profile, desktop, and automations. */
export function DetailsPanel({ bot }: { bot: Bot }) {
  const working = useWorking(bot.id);
  const schedules = useQuery(schedulesQuery);

  const automations =
    schedules.data?.filter(
      (schedule) => schedule.agentId === bot.id && !finished(schedule),
    ) ?? [];

  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l p-4 lg:flex">
      <ProfileSummary bot={bot} working={working} />
      {bot.tools.includes("desktop") && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Desktop</h2>
          <DesktopPreview key={bot.id} botId={bot.id} />
        </section>
      )}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Automations
        </h2>
        <AutomationList schedules={schedules} automations={automations} />
      </section>
    </aside>
  );
}
