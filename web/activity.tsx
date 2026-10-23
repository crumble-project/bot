import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { type ActivityFeed, activityFeedQuery } from "./api";
import { WorkspacePage } from "./workspace";

type Activity = ActivityFeed["activities"][number];

type Communication = { fromName?: string; toName?: string };

type Details = {
  toolName?: string;
  name?: string;
  content?: string;
  communication?: Communication;
};

function details(activity: Activity): Details {
  // SAFETY: the activity feed copies these fields from transcript tool calls and bot messages.
  return activity.details as Details;
}

function kindLabel(activity: Activity) {
  const { toolName, name: toolLabel, communication } = details(activity);
  const name = toolName ?? toolLabel;

  switch (activity.kind) {
    case "tool-call":
      return `Tool call · ${name ?? "tool"}`;
    case "tool-result":
      return `Tool result · ${name ?? "tool"}`;
    case "mcp-call":
      return `MCP call · ${name ?? "server"}`;
    case "bot-message": {
      const { fromName, toName } = communication ?? {};

      return `Bot message · ${fromName ?? "?"} → ${toName ?? "?"}`;
    }
  }
}

function detailText(activity: Activity) {
  if (activity.kind === "bot-message") return details(activity).content ?? "";

  return JSON.stringify(activity.details, null, 2);
}

export function ActivityPage() {
  const feed = useQuery(activityFeedQuery);

  return (
    <WorkspacePage
      title="Activity"
      refreshing={feed.isFetching}
      onRefresh={() => void feed.refetch()}
    >
      {feed.isPending ? (
        <Skeleton className="h-40" />
      ) : feed.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{feed.error.message}</AlertDescription>
        </Alert>
      ) : feed.data.activities.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No Activity</EmptyTitle>
            <EmptyDescription>
              Tool calls and bot messages will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col divide-y rounded-lg border">
          {feed.data.activities.map((activity) => (
            <ActivityRow key={activity.id} activity={activity} />
          ))}
        </div>
      )}
    </WorkspacePage>
  );
}

function ActivityRow({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const Icon = open ? ArrowDown01Icon : ArrowRight01Icon;

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="max-w-full truncate">
          {kindLabel(activity)}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {activity.timestamp
            ? new Date(activity.timestamp).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })
            : null}
          {activity.timestamp ? " · " : ""}
          {activity.agentName}
        </span>
        <Button
          variant="ghost"
          size="sm"
          render={
            <Link to="/bots/$botId" params={{ botId: activity.agentId }} />
          }
          nativeButton={false}
        >
          Open Chat
        </Button>
      </div>
      <button
        type="button"
        className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <HugeiconsIcon icon={Icon} className="size-3.5" />
        Details
      </button>
      {open && (
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
          {detailText(activity)}
        </pre>
      )}
    </div>
  );
}
