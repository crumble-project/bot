import { type ReactNode, useState } from "react";
import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import {
  IconBrain,
  IconChevronRight,
  IconCornerDownRight,
  IconHistory,
  IconMessages,
  IconPlug,
  IconTool,
  type TablerIcon,
} from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { cn } from "@/lib/utils";
import {
  type ActivityFeed,
  type Bot,
  api,
  botsQuery,
  queryClient,
} from "@/lib/api";
import { BotAvatar } from "@/features/bots/avatar";
import {
  ChangeDiff,
  RevertChange,
  changeSummary,
  changeTitle,
} from "./changes";
import { WorkspacePage } from "@/components/workspace";

type Activity = ActivityFeed["activities"][number];

type Operational = Exclude<Activity, { kind: "change" }>;

const PREVIEW_CHARS = 240;

// Anything a call sent or a result returned, as text: strings as they are, other values as JSON.
const asText = z.union([
  z.string(),
  z.unknown().transform((value) => JSON.stringify(value) ?? ""),
]);

const detailsInput = z.object({
  toolName: z.string().optional(),
  name: z.string().optional(),
  content: asText.optional(),
  arguments: asText.optional(),
  args: z.string().optional(),
  isError: z.boolean().optional(),
  error: z.string().optional(),
  communication: z
    .object({ fromName: z.string().optional(), toName: z.string().optional() })
    .optional(),
});

const details = (activity: Operational) =>
  detailsInput.safeParse(activity.details).data ?? {};

const PAGE_SIZE = 50;
const ALL = "all";

const KINDS = {
  "tool-call": { label: "Tool calls", icon: IconTool },
  "tool-result": { label: "Tool results", icon: IconCornerDownRight },
  "mcp-call": { label: "MCP calls", icon: IconPlug },
  "bot-message": { label: "Bot messages", icon: IconMessages },
  change: { label: "Changes", icon: IconHistory },
} satisfies Record<Activity["kind"], { label: string; icon: TablerIcon }>;

const KIND_ORDER = [
  "tool-call",
  "tool-result",
  "mcp-call",
  "bot-message",
  "change",
] satisfies Activity["kind"][];

/** A one-line glimpse of what a call sent or a result returned. */
const previewOf = (text = "") =>
  text.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS);

/** What the bot did, as the verb and object of a sentence that starts with its name. */
function sentenceOf(activity: Operational) {
  const { toolName, name, isError, communication } = details(activity);
  const tool = toolName ?? name ?? "a tool";

  switch (activity.kind) {
    case "tool-call":
      return { verb: "used", object: tool };
    case "tool-result":
      return {
        verb: isError ? "got an error from" : "got a result from",
        object: tool,
      };
    case "mcp-call":
      return { verb: "called", object: name ?? "an MCP tool" };
    case "bot-message":
      return { verb: "messaged", object: communication?.toName ?? "a bot" };
  }
}

function previewText(activity: Operational) {
  const { content, arguments: args, args: argText, error } = details(activity);

  if (activity.kind === "tool-result" || activity.kind === "bot-message")
    return previewOf(content);

  return previewOf(error ?? argText ?? args);
}

function detailText(activity: Operational) {
  const { content } = details(activity);

  if (activity.kind === "bot-message" && content) return content;

  return JSON.stringify(activity.details, null, 2);
}

function useActivityFeed(kind: string, agentId: string) {
  return useInfiniteQuery({
    queryKey: ["activity", kind, agentId],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });

      if (kind !== ALL) params.set("kind", kind);

      if (agentId !== ALL) params.set("agentId", agentId);

      if (pageParam) params.set("cursor", pageParam);

      return api<ActivityFeed>(`/v1/activity/feed?${params}`, { signal });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

function dayKey(timestamp: number | undefined) {
  if (timestamp === undefined) return "undated";

  const date = new Date(timestamp);

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(timestamp: number | undefined, now: Date) {
  if (timestamp === undefined) return "Earlier";

  const date = new Date(timestamp);

  const midnight = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();

  const days = Math.round((midnight(now) - midnight(date)) / 86_400_000);

  if (days === 0) return "Today";

  if (days === 1) return "Yesterday";

  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(date.getFullYear() !== now.getFullYear() && { year: "numeric" }),
  });
}

/** Activities by the day they happened, newest day first, in feed order. */
function byDay(activities: Activity[], now: Date) {
  const days = new Map<string, { label: string; items: Activity[] }>();

  for (const activity of activities) {
    const key = dayKey(activity.timestamp);

    const day = days.get(key) ?? {
      label: dayLabel(activity.timestamp, now),
      items: [],
    };

    day.items.push(activity);
    days.set(key, day);
  }

  return [...days.entries()];
}

export function ActivityPage() {
  const bots = useQuery(botsQuery);
  const [kind, setKind] = useState(ALL);
  const [agentId, setAgentId] = useState(ALL);
  const feed = useActivityFeed(kind, agentId);
  const botsById = new Map((bots.data ?? []).map((bot) => [bot.id, bot]));

  return (
    <WorkspacePage
      title="Activity"
      refreshing={feed.isFetching}
      onRefresh={() =>
        void queryClient.resetQueries({ queryKey: ["activity"] })
      }
    >
      <div className="flex items-center justify-between gap-2">
        <KindPills kind={kind} onChange={setKind} />
        <BotFilter
          bots={bots.data ?? []}
          value={agentId}
          onChange={setAgentId}
        />
      </div>
      <ActivityBody feed={feed} kind={kind} botsById={botsById} />
    </WorkspacePage>
  );
}

function KindPills({
  kind,
  onChange,
}: {
  kind: string;
  onChange: (kind: string) => void;
}) {
  const pills = [
    { value: ALL, label: "All", icon: null },
    ...KIND_ORDER.map((value) => {
      const Icon = KINDS[value].icon;

      return { value, label: KINDS[value].label, icon: <Icon /> };
    }),
  ];

  return (
    <div
      role="group"
      aria-label="Kind of activity"
      className="-mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 pb-1"
    >
      {pills.map((pill) => (
        <Button
          key={pill.value}
          type="button"
          size="sm"
          variant={kind === pill.value ? "secondary" : "ghost"}
          aria-pressed={kind === pill.value}
          className="shrink-0 rounded-full"
          onClick={() => onChange(pill.value)}
        >
          {pill.icon}
          {pill.label}
        </Button>
      ))}
    </div>
  );
}

function BotFilter({
  bots,
  value,
  onChange,
}: {
  bots: Bot[];
  value: string;
  onChange: (agentId: string) => void;
}) {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));

  const items = [
    { label: "All bots", value: ALL },
    ...bots.map((bot) => ({ label: bot.name, value: bot.id })),
  ];

  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => onChange(next ?? ALL)}
    >
      <SelectTrigger aria-label="Bot" size="sm" className="w-auto shrink-0">
        <SelectValue>
          {(selected: string) => {
            const bot = byId.get(selected);

            return bot ? (
              <span className="flex items-center gap-1.5">
                <BotAvatar bot={bot} size={18} />
                {bot.name}
              </span>
            ) : (
              "All bots"
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          {items.map((item) => {
            const bot = byId.get(item.value);

            return (
              <SelectItem key={item.value} value={item.value}>
                <span className="flex items-center gap-1.5">
                  {bot && <BotAvatar bot={bot} size={18} />}
                  {item.label}
                </span>
              </SelectItem>
            );
          })}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function ActivityEmpty({ kind }: { kind: string }) {
  return (
    <Empty className="rounded-xl border">
      <EmptyHeader>
        <EmptyTitle className="font-heading text-lg">
          No activity yet
        </EmptyTitle>
        <EmptyDescription>
          {kind === ALL
            ? "Tool calls, bot messages, and skill and memory changes will appear here."
            : "Nothing of this kind yet."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ActivityBody({
  feed,
  kind,
  botsById,
}: {
  feed: UseInfiniteQueryResult<InfiniteData<ActivityFeed>>;
  kind: string;
  botsById: Map<string, Bot>;
}) {
  const activities = feed.data?.pages.flatMap((page) => page.activities) ?? [];

  if (feed.isPending) return <Skeleton className="h-40 rounded-xl" />;

  if (feed.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{feed.error.message}</AlertDescription>
      </Alert>
    );

  if (activities.length === 0 && !feed.hasNextPage)
    return <ActivityEmpty kind={kind} />;

  return (
    <>
      {byDay(activities, new Date()).map(([key, day]) => (
        <section key={key} className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            {day.label}
          </h2>
          <div className="flex flex-col divide-y overflow-hidden rounded-xl border bg-muted/30">
            {day.items.map((activity) => (
              <ActivityRow
                key={activity.id}
                activity={activity}
                bot={
                  activity.agentId ? botsById.get(activity.agentId) : undefined
                }
              />
            ))}
          </div>
        </section>
      ))}
      {feed.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={feed.isFetchingNextPage}
          onClick={() => void feed.fetchNextPage()}
        >
          {feed.isFetchingNextPage && <Spinner data-icon="inline-start" />}
          Show older activity
        </Button>
      )}
    </>
  );
}

/** The bot's avatar with a small badge for the kind of activity. */
function ActivityMark({
  activity,
  bot,
}: {
  activity: Activity;
  bot?: Bot | undefined;
}) {
  const Icon = KINDS[activity.kind].icon;

  return (
    <span className="relative mt-0.5 shrink-0">
      {bot ? (
        <BotAvatar bot={bot} size={30} />
      ) : (
        <span className="flex size-[30px] items-center justify-center rounded-full bg-muted text-muted-foreground">
          <IconBrain className="size-4" />
        </span>
      )}
      <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground">
        <Icon className="size-2.5" />
      </span>
    </span>
  );
}

function Headline({ activity }: { activity: Activity }) {
  if (activity.kind === "change")
    return (
      <>
        <span className="font-medium">
          {changeSummary(activity.change, activity.agentName)}
        </span>
        <span className="text-muted-foreground">
          {" "}
          · {changeTitle(activity.change)}
        </span>
      </>
    );

  const { verb, object } = sentenceOf(activity);

  const actor =
    activity.kind === "bot-message"
      ? (details(activity).communication?.fromName ?? activity.agentName)
      : activity.agentName;

  return (
    <>
      <span className="font-medium">{actor}</span>{" "}
      <span className="text-muted-foreground">{verb}</span>{" "}
      <span
        className={cn(
          "font-medium",
          activity.kind !== "bot-message" && "font-mono text-[0.8125rem]",
        )}
      >
        {object}
      </span>
    </>
  );
}

function Preview({ activity }: { activity: Activity }) {
  if (activity.kind === "change") return null;

  const text = previewText(activity);

  if (!text) return null;

  return (
    <p
      className={cn(
        "text-muted-foreground",
        activity.kind === "bot-message"
          ? "line-clamp-2 text-sm"
          : "truncate font-mono text-xs",
      )}
    >
      {text}
    </p>
  );
}

function timeOf(activity: Activity) {
  return activity.timestamp
    ? new Date(activity.timestamp).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}

function failed(activity: Activity) {
  if (activity.kind === "change") return false;

  const { isError, error } = details(activity);

  return isError === true || Boolean(error);
}

function ActivityRow({
  activity,
  bot,
}: {
  activity: Activity;
  bot?: Bot | undefined;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("transition-colors", open && "bg-background")}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={() => setOpen(!open)}
      >
        <ActivityMark activity={activity} bot={bot} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="truncate text-sm">
            <Headline activity={activity} />
          </p>
          <Preview activity={activity} />
        </div>
        <span className="flex shrink-0 items-center gap-2 pt-0.5 text-xs text-muted-foreground tabular-nums">
          {failed(activity) && <Badge variant="destructive">Error</Badge>}
          {timeOf(activity)}
          <IconChevronRight
            className={cn("size-4 transition-transform", open && "rotate-90")}
          />
        </span>
      </button>
      {open && <ActivityDetails activity={activity} />}
    </div>
  );
}

function ActivityDetails({ activity }: { activity: Activity }) {
  return (
    <div className="flex flex-col gap-2 px-3 pb-3 pl-[3.375rem]">
      {activity.kind === "change" ? (
        <ChangeDiff change={activity.change} />
      ) : (
        <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-all">
          {detailText(activity)}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <ActivityAction activity={activity} />
      </div>
    </div>
  );
}

function ActivityAction({ activity }: { activity: Activity }): ReactNode {
  if (activity.kind === "change")
    return <RevertChange change={activity.change} />;

  return (
    <Button
      variant="ghost"
      size="sm"
      render={<Link to="/bots/$botId" params={{ botId: activity.agentId }} />}
      nativeButton={false}
    >
      Open chat
    </Button>
  );
}
