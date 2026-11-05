import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { IconRobot, IconPlus } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { CrumbleMark } from "@/components/crumble-mark";
import { cn } from "@/lib/utils";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { type Bot, botsQuery } from "@/features/bots/api";
import { botStatusLine, isBusy, useActivity } from "@/features/bots/activity";
import { botColor, botStyle } from "@/components/bot-avatar";
import { LiveBotAvatar } from "@/features/bots/avatar";

function greeting(hour: number) {
  if (hour < 5) return "Up late";

  if (hour < 12) return "Good morning";

  if (hour < 18) return "Good afternoon";

  return "Good evening";
}

const TODAY = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
});

const STAGGER_MS = 40;

const ENTER =
  "animate-in fill-mode-both fade-in slide-in-from-bottom-2 duration-300 ease-out";

export function Home() {
  const bots = useQuery(botsQuery);

  if (bots.data?.length)
    return (
      <div className="m-auto flex w-full max-w-4xl flex-col items-center gap-10 px-6 py-12">
        <div className="flex animate-in flex-col items-center gap-2 text-center duration-300 ease-out fade-in slide-in-from-bottom-1">
          <CrumbleMark className="mb-2 size-9" />
          <h1 className="font-heading text-4xl font-semibold tracking-tight">
            {greeting(new Date().getHours())}
          </h1>
          <p className="text-sm text-muted-foreground">
            {TODAY.format(new Date())}
          </p>
        </div>
        <ul className="flex flex-wrap justify-center gap-3">
          {bots.data.map((bot, index) => (
            <HouseholdBot key={bot.id} bot={bot} index={index} />
          ))}
          <li
            className={cn(ENTER, "w-40")}
            style={{ animationDelay: `${bots.data.length * STAGGER_MS}ms` }}
          >
            <Link
              to="/bots/new"
              className="flex h-full flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed p-5 text-sm text-muted-foreground transition-colors duration-150 hover:border-foreground/30 hover:bg-muted hover:text-foreground"
            >
              <span className="flex size-12 items-center justify-center rounded-full bg-muted">
                <IconPlus className="size-5" />
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

function HouseholdBot({ bot, index }: { bot: Bot; index: number }) {
  const working = isBusy(useActivity(bot.id));

  return (
    <li
      className={cn(ENTER, "w-40")}
      style={{
        ...botStyle(botColor(bot)),
        animationDelay: `${index * STAGGER_MS}ms`,
      }}
    >
      <Link
        to="/bots/$botId"
        params={{ botId: bot.id }}
        className="group/bot relative flex h-full flex-col items-center gap-3 overflow-hidden rounded-3xl bg-card p-5 pt-6 text-center shadow-xs ring-1 ring-border transition-[translate,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:shadow-none dark:hover:ring-foreground/20"
      >
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-16 bg-bot-soft transition-[height] duration-200 ease-out group-hover/bot:h-20"
        />
        <span className="relative">
          <LiveBotAvatar bot={bot} size={80} />
        </span>
        <span className="relative flex w-full flex-col gap-0.5">
          <span className="truncate font-heading font-semibold">
            {bot.name}
          </span>
          <span className="flex items-center justify-center gap-1.5 truncate text-xs text-muted-foreground">
            {working && (
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-bot-strong" />
            )}
            <span className="truncate">
              {botStatusLine(bot, working, bot.description || "Ready")}
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}
