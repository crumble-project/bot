import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type Bot,
  type Schedule,
  botMemoriesQuery,
  queryClient,
  schedulesQuery,
  send,
} from "./api";
import { BotAvatar } from "./avatar";
import { useWorking } from "./live";
import { sourceLabel } from "./memory";
import { taskTiming } from "./tasks";

function Routine({ schedule }: { schedule: Schedule }) {
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
          {taskTiming(schedule)}
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

/** The bot inspector beside its chat: profile, routines, model, and memory. */
export function DetailsPanel({ bot }: { bot: Bot }) {
  const working = useWorking(bot.id);
  const schedules = useQuery(schedulesQuery);
  const memories = useQuery(botMemoriesQuery(bot.id));

  const routines =
    schedules.data?.filter((schedule) => schedule.agentId === bot.id) ?? [];

  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l p-4 lg:flex">
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
        <Button
          variant="link"
          size="sm"
          render={<Link to="/bots/$botId/edit" params={{ botId: bot.id }} />}
          nativeButton={false}
        >
          Edit profile…
        </Button>
      </div>
      <Tabs defaultValue="details">
        <TabsList className="w-full">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
        </TabsList>
        <TabsContent value="details" className="flex flex-col gap-4 pt-3">
          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-medium text-muted-foreground">
              Routines
            </h3>
            {schedules.isPending && <Skeleton className="h-10" />}
            {routines.map((schedule) => (
              <Routine key={schedule.id} schedule={schedule} />
            ))}
            {schedules.isSuccess && routines.length === 0 && (
              <p className="text-sm text-muted-foreground">No routines yet</p>
            )}
          </section>
          <Separator />
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">Model</h3>
            <span className="text-sm">{bot.model || "Default"}</span>
            <span className="text-xs text-muted-foreground">
              {bot.provider}
            </span>
          </section>
        </TabsContent>
        <TabsContent value="memory" className="flex flex-col gap-3 pt-3">
          {memories.isPending && <Skeleton className="h-16" />}
          {memories.data?.map((memory) => (
            <div key={memory.id} className="flex flex-col gap-0.5">
              <p className="line-clamp-4 text-sm">{memory.content}</p>
              {sourceLabel(memory) && (
                <span className="text-xs text-muted-foreground">
                  {sourceLabel(memory)}
                </span>
              )}
            </div>
          ))}
          {memories.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing remembered yet
            </p>
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}
