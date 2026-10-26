import { Fragment, type MouseEvent, useRef, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  BrainIcon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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

type Communication = { fromName?: string; toName?: string };

type Details = {
  toolName?: string;
  name?: string;
  content?: string;
  communication?: Communication;
};

function details(activity: Operational): Details {
  // SAFETY: the activity feed copies these fields from transcript tool calls and bot messages.
  return activity.details as Details;
}

const CALL_LABELS = {
  "tool-call": { prefix: "Tool call", fallback: "tool" },
  "tool-result": { prefix: "Tool result", fallback: "tool" },
  "mcp-call": { prefix: "MCP call", fallback: "server" },
};

function kindLabel(activity: Operational) {
  const { toolName, name: toolLabel, communication } = details(activity);

  if (activity.kind === "bot-message") {
    const { fromName, toName } = communication ?? {};

    return `Bot message · ${fromName ?? "?"} → ${toName ?? "?"}`;
  }

  const { prefix, fallback } = CALL_LABELS[activity.kind];

  return `${prefix} · ${toolName ?? toolLabel ?? fallback}`;
}

function detailText(activity: Operational) {
  if (activity.kind === "bot-message") return details(activity).content ?? "";

  return JSON.stringify(activity.details, null, 2);
}

const PAGE_SIZE = 50;
const ALL = "all";

const KINDS = [
  { label: "All activity", value: ALL },
  { label: "Tool calls", value: "tool-call" },
  { label: "Tool results", value: "tool-result" },
  { label: "MCP calls", value: "mcp-call" },
  { label: "Bot messages", value: "bot-message" },
  { label: "Changes", value: "change" },
];

function useActivityFeed(kind: string, cursor: string) {
  return useQuery({
    queryKey: ["activity", kind, cursor],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });

      if (kind !== ALL) params.set("kind", kind);

      if (cursor) params.set("cursor", cursor);

      return api<ActivityFeed>(`/v1/activity/feed?${params}`, { signal });
    },
    placeholderData: keepPreviousData,
  });
}

export function ActivityPage() {
  const bots = useQuery(botsQuery);
  const [kind, setKind] = useState(ALL);
  // The feed pages by cursor, so pages are numbered as they are reached; cursors[n] opens page n.
  const [cursors, setCursors] = useState([""]);
  const [page, setPage] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  const cursor = cursors[page] ?? "";

  const feed = useActivityFeed(kind, cursor);

  const nextCursor = feed.isPlaceholderData ? null : feed.data?.nextCursor;

  const botsById = new Map((bots.data ?? []).map((bot) => [bot.id, bot]));

  const go = (target: number) => {
    if (target < 0 || target > cursors.length) return;

    if (target === cursors.length) {
      if (!nextCursor) return;
      setCursors([...cursors, nextCursor]);
    }

    setPage(target);
    top.current?.scrollIntoView({ block: "start" });
  };

  const restart = (nextKind = kind) => {
    setKind(nextKind);
    setCursors([""]);
    setPage(0);
  };

  return (
    <WorkspacePage
      title="Activity"
      refreshing={feed.isFetching}
      onRefresh={() => {
        restart();
        void queryClient.invalidateQueries({ queryKey: ["activity"] });
      }}
    >
      <div ref={top} className="scroll-mt-6">
        <KindSelect kind={kind} onChange={(value) => restart(value)} />
      </div>
      <ActivityBody
        feed={feed}
        kind={kind}
        page={page}
        known={cursors.length}
        nextCursor={nextCursor}
        botsById={botsById}
        onPage={go}
      />
    </WorkspacePage>
  );
}

function KindSelect({
  kind,
  onChange,
}: {
  kind: string;
  onChange: (kind: string) => void;
}) {
  return (
    <Select
      items={KINDS}
      value={kind}
      onValueChange={(value) => onChange(value ?? ALL)}
    >
      <SelectTrigger className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {KINDS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function ActivityEmpty({ kind }: { kind: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No Activity</EmptyTitle>
        <EmptyDescription>
          {kind === ALL
            ? "Tool calls, bot messages, and skill and memory changes will appear here."
            : "Nothing of this kind yet."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ActivityList({
  items,
  botsById,
}: {
  items: Activity[];
  botsById: Map<string, Bot>;
}) {
  if (items.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Nothing on this page. Older activity continues on the next one.
      </p>
    );

  return (
    <div className="flex flex-col divide-y rounded-lg border">
      {items.map((activity) => (
        <ActivityRow
          key={activity.id}
          activity={activity}
          bot={activity.agentId ? botsById.get(activity.agentId) : undefined}
        />
      ))}
    </div>
  );
}

function ActivityBody({
  feed,
  kind,
  page,
  known,
  nextCursor,
  botsById,
  onPage,
}: {
  feed: UseQueryResult<ActivityFeed>;
  kind: string;
  page: number;
  known: number;
  nextCursor: string | null | undefined;
  botsById: Map<string, Bot>;
  onPage: (page: number) => void;
}) {
  const items = feed.data?.activities ?? [];

  if (feed.isPending) return <Skeleton className="h-40" />;

  if (feed.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{feed.error.message}</AlertDescription>
      </Alert>
    );

  if (items.length === 0 && page === 0 && !nextCursor)
    return <ActivityEmpty kind={kind} />;

  return (
    <>
      <ActivityList items={items} botsById={botsById} />
      <ActivityPagination
        page={page}
        known={known}
        hasNext={Boolean(nextCursor)}
        onPage={onPage}
      />
    </>
  );
}

/** Numbered pages around the current one; pages past the last one reached show as an ellipsis. */
function ActivityPagination({
  page,
  known,
  hasNext,
  onPage,
}: {
  page: number;
  known: number;
  hasNext: boolean;
  onPage: (page: number) => void;
}) {
  const last = Math.max(known - 1, page + (hasNext ? 1 : 0));

  const shown = [...new Set([0, page - 1, page, page + 1, last])]
    .filter((n) => n >= 0 && n <= last)
    .sort((a, b) => a - b);

  if (last === 0) return null;

  const link = (target: number) => ({
    href: "#",
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onPage(target);
    },
  });

  return (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            {...link(page - 1)}
            aria-disabled={page === 0}
            className={cn(page === 0 && "pointer-events-none opacity-50")}
          />
        </PaginationItem>
        {shown.map((n, index) => (
          <Fragment key={n}>
            {index > 0 && n - shown[index - 1]! > 1 && (
              <PaginationItem>
                <PaginationEllipsis />
              </PaginationItem>
            )}
            <PaginationItem>
              <PaginationLink {...link(n)} isActive={n === page}>
                {n + 1}
              </PaginationLink>
            </PaginationItem>
          </Fragment>
        ))}
        {hasNext && page + 1 === last && (
          <PaginationItem>
            <PaginationEllipsis />
          </PaginationItem>
        )}
        <PaginationItem>
          <PaginationNext
            {...link(page + 1)}
            aria-disabled={!hasNext && page === last}
            className={cn(
              !hasNext && page === last && "pointer-events-none opacity-50",
            )}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

function ActivityRow({
  activity,
  bot,
}: {
  activity: Activity;
  bot?: Bot | undefined;
}) {
  const [open, setOpen] = useState(false);
  const Icon = open ? ArrowDown01Icon : ArrowRight01Icon;

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-3">
        {bot ? (
          <BotAvatar bot={bot} size={28} />
        ) : (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <HugeiconsIcon icon={BrainIcon} className="size-4" />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-sm">
            <ActivityTitle activity={activity} />
          </p>
          <span className="truncate text-xs text-muted-foreground">
            {activity.timestamp
              ? `${new Date(activity.timestamp).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })} · `
              : ""}
            {activity.agentName ?? "Shared"}
          </span>
        </div>
        <ActivityAction activity={activity} />
      </div>
      <button
        type="button"
        className="ml-10 flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <HugeiconsIcon icon={Icon} className="size-3.5" />
        Details
      </button>
      {open &&
        (activity.kind === "change" ? (
          <ChangeDiff change={activity.change} />
        ) : (
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
            {detailText(activity)}
          </pre>
        ))}
    </div>
  );
}

function ActivityTitle({ activity }: { activity: Activity }) {
  if (activity.kind !== "change") return kindLabel(activity);

  return (
    <>
      {changeSummary(activity.change, activity.agentName)}
      <span className="text-muted-foreground">
        {" "}
        · {changeTitle(activity.change)}
      </span>
    </>
  );
}

function ActivityAction({ activity }: { activity: Activity }) {
  if (activity.kind === "change")
    return <RevertChange change={activity.change} />;

  if (!activity.agentId) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      render={<Link to="/bots/$botId" params={{ botId: activity.agentId }} />}
      nativeButton={false}
    >
      Open Chat
    </Button>
  );
}
