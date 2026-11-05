import {
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { IconPencil, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { Bot } from "@/features/bots/api";
import {
  type Schedule,
  schedulesQuery,
  toggleScheduleOptions,
} from "@/features/automations/api";
import { eventSourcesQuery } from "@/features/event-sources/api";
import { LiveBotAvatar } from "./avatar";
import { DesktopPreview } from "@/features/bot-desktop/desktop";
import { automationTiming, finished } from "@/features/automations/timing";
import { BOT_TOOL } from "@crumble/server/contract/tools";

function Automation({ schedule }: { schedule: Schedule }) {
  const sources = useQuery(eventSourcesQuery).data;

  const toggle = useMutation(toggleScheduleOptions(schedule.id));

  return (
    <div className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{schedule.name}</span>
        <span className="text-xs text-muted-foreground">
          {automationTiming(schedule, sources)}
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

function ProfileSummary({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  return (
    <div className="relative flex flex-col items-center gap-2 pt-6 text-center">
      <div className="absolute -top-1 -right-1 flex gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          title="Edit bot"
          render={<Link to="/bots/$botId/edit" params={{ botId: bot.id }} />}
          nativeButton={false}
        >
          <IconPencil />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Close" onClick={onClose}>
          <IconX />
        </Button>
      </div>
      <LiveBotAvatar bot={bot} size={84} />
      <span className="font-heading text-lg font-semibold">{bot.name}</span>
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

function DetailsBody({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const schedules = useQuery(schedulesQuery);

  const automations =
    schedules.data?.filter(
      (schedule) => schedule.agentId === bot.id && !finished(schedule),
    ) ?? [];

  return (
    <div className="flex flex-col gap-4 p-4">
      <ProfileSummary bot={bot} onClose={onClose} />
      {bot.tools.includes(BOT_TOOL.desktop) && (
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
    </div>
  );
}

/** The bot inspector beside its chat on wide screens: profile, desktop, and automations. */
export function DetailsPanel({
  bot,
  onClose,
}: {
  bot: Bot;
  onClose: () => void;
}) {
  return (
    <ScrollArea
      render={<aside />}
      className="hidden w-72 shrink-0 border-l lg:block"
    >
      <DetailsBody bot={bot} onClose={onClose} />
    </ScrollArea>
  );
}

/** The same inspector as a sheet, for screens too narrow for the side panel. */
export function DetailsSheet({
  bot,
  open,
  onOpenChange,
}: {
  bot: Bot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent showCloseButton={false} className="overflow-y-auto">
        <SheetTitle className="sr-only">{bot.name}</SheetTitle>
        <DetailsBody bot={bot} onClose={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
