import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { IconRobot, IconPlus } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { type Bot, botsQuery } from "@/lib/api";
import { useWorking } from "@/lib/live";
import { BotAvatar, botColor, botStyle } from "@/features/bots/avatar";

function greeting(hour: number) {
  if (hour < 5) return "Up late";

  if (hour < 12) return "Good morning";

  if (hour < 18) return "Good afternoon";

  return "Good evening";
}

export function Home() {
  const bots = useQuery(botsQuery);

  if (bots.data?.length)
    return (
      <div className="m-auto flex w-full max-w-4xl flex-col items-center gap-10 px-6 py-12">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          {greeting(new Date().getHours())}
        </h1>
        <ul className="flex flex-wrap justify-center gap-2">
          {bots.data.map((bot) => (
            <HouseholdBot key={bot.id} bot={bot} />
          ))}
          <li>
            <Link
              to="/bots/new"
              className="flex h-full w-36 flex-col items-center justify-center gap-3 rounded-3xl p-4 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
            >
              <span className="flex size-[88px] items-center justify-center rounded-full border-2 border-dashed">
                <IconPlus className="size-6" />
              </span>
              New bot
            </Link>
          </li>
        </ul>
      </div>
    );

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <IconRobot />
        </EmptyMedia>
        <EmptyTitle className="font-heading text-lg">
          {bots.isPending
            ? "Opening your workspace"
            : "A little help, always here."}
        </EmptyTitle>
        {!bots.isPending && (
          <EmptyDescription>Create a bot to start chatting.</EmptyDescription>
        )}
      </EmptyHeader>
      {bots.data && (
        <EmptyContent>
          <Button render={<Link to="/bots/new" />} nativeButton={false}>
            <IconPlus data-icon="inline-start" />
            Create a bot
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

function HouseholdBot({ bot }: { bot: Bot }) {
  const working = useWorking(bot.id);

  return (
    <li style={botStyle(botColor(bot))}>
      <Link
        to="/bots/$botId"
        params={{ botId: bot.id }}
        className="flex w-36 flex-col items-center gap-3 rounded-3xl p-4 text-center transition-colors duration-150 hover:bg-bot-soft focus-visible:bg-bot-soft focus-visible:outline-none"
      >
        <BotAvatar
          bot={bot}
          size={88}
          live
          state={working ? "working" : bot.enabled ? "idle" : "sleeping"}
        />
        <span className="flex w-full flex-col gap-0.5">
          <span className="truncate font-heading font-semibold">
            {bot.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {working
              ? "Working…"
              : !bot.enabled
                ? "Paused"
                : bot.description || "Ready"}
          </span>
        </span>
      </Link>
    </li>
  );
}
