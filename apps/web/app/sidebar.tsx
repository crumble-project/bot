import { Link, useMatchRoute } from "@tanstack/react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  IconDots,
  IconPin,
  IconPlus,
  IconSearch,
  IconSettings,
} from "@tabler/icons-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CrumbleMark } from "@/components/crumble-mark";
import { botColor, botStyle } from "@/components/bot-avatar";
import { StatusBotAvatar } from "@/features/bot-chat/avatar";
import type { Bot } from "@/features/bots/api";
import { botLabel } from "@/features/bots/status";
import { botPin } from "@/lib/pins";
import type { Pins } from "@/lib/pins";
import { cn } from "@/lib/utils";
import { useConnectionStatus } from "./activity-stream";
import { ACTIVITY, AUTOMATIONS } from "./navigation";
import { PinnedBots } from "./pinned-bots";
import { UnreadDot, useBotUnread } from "./unread";

const SETTINGS = {
  to: "/settings",
  label: "Settings",
  icon: IconSettings,
} as const;

const ICON_BUTTON =
  "relative grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground outline-hidden transition-[background-color,color,scale] after:absolute after:-inset-1 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring active:scale-[0.96] [&_svg]:size-4.5";

const WORDMARK =
  "mr-auto flex items-center gap-2 rounded-lg px-2 font-heading text-lg font-semibold tracking-tight outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring";

function HeaderLink({ item }: { item: typeof ACTIVITY | typeof SETTINGS }) {
  const matchRoute = useMatchRoute();

  return (
    <Link
      to={item.to}
      title={item.label}
      aria-label={item.label}
      className={cn(
        ICON_BUTTON,
        matchRoute({ to: item.to, fuzzy: true }) &&
          "bg-sidebar-accent text-foreground",
      )}
    >
      <item.icon />
    </Link>
  );
}

function ConnectionNote() {
  const status = useConnectionStatus();

  if (status === "connected") {
    return null;
  }

  return (
    <p role="status" className="px-4 pb-1 text-xs text-destructive">
      {status === "reconnecting" ? "Reconnecting…" : "Disconnected"}
    </p>
  );
}

function PinAction({ botKey, pins }: { botKey: string; pins: Pins }) {
  if (!pins.ready) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<SidebarMenuAction showOnHover title="More" />}
      >
        <IconDots />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        <DropdownMenuItem
          disabled={!pins.canPin(botKey)}
          onClick={() => pins.pin(botKey)}
        >
          <IconPin />
          Pin
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BotRow({
  bot,
  active,
  pins,
}: {
  bot: Bot;
  active: boolean;
  pins: Pins;
}) {
  const unread = useBotUnread(bot.id);
  const label = botLabel(bot, { pinned: false, unread });

  return (
    <SidebarMenuItem style={botStyle(botColor(bot))}>
      <SidebarMenuButton
        isActive={active}
        title={label}
        aria-label={label}
        className="data-active:bg-bot-soft!"
        render={<Link to="/bots/$botId" params={{ botId: bot.id }} />}
      >
        <StatusBotAvatar bot={bot} size={20} />
        <span
          className={cn(
            "truncate",
            unread > 0 && "font-semibold",
            !bot.enabled && "opacity-60",
          )}
        >
          {bot.name}
        </span>
        {unread > 0 && <UnreadDot className="ml-auto" />}
      </SidebarMenuButton>
      <PinAction botKey={botPin(bot.id)} pins={pins} />
    </SidebarMenuItem>
  );
}

function AutomationsRow() {
  const matchRoute = useMatchRoute();

  return (
    <SidebarGroup>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={Boolean(matchRoute({ to: AUTOMATIONS.to }))}
            render={<Link to={AUTOMATIONS.to} />}
          >
            <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
              <AUTOMATIONS.icon />
            </span>
            <span>{AUTOMATIONS.label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}

function BotsSection({
  bots,
  unpinned,
  pins,
  activeId,
}: {
  bots: UseQueryResult<Array<Bot>>;
  unpinned: Array<Bot>;
  pins: Pins;
  activeId: string | undefined;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Bots</SidebarGroupLabel>
      <SidebarGroupAction title="New bot" render={<Link to="/bots/new" />}>
        <IconPlus />
        <span className="sr-only">New bot</span>
      </SidebarGroupAction>
      <SidebarGroupContent>
        <SidebarMenu>
          {bots.isPending &&
            [0, 1, 2].map((index) => (
              <SidebarMenuItem key={index}>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
            ))}
          {unpinned.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              active={activeId === bot.id}
              pins={pins}
            />
          ))}
          {bots.data?.length === 0 && (
            <p className="px-2 text-xs text-muted-foreground">No bots yet</p>
          )}
        </SidebarMenu>
        {bots.isError && (
          <p className="px-2 text-xs text-destructive">{bots.error.message}</p>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppSidebar({
  bots,
  pins,
  onSearch,
}: {
  bots: UseQueryResult<Array<Bot>>;
  pins: Pins;
  onSearch: () => void;
}) {
  const matchRoute = useMatchRoute();
  const match = matchRoute({ to: "/bots/$botId", fuzzy: true });
  const activeId = match ? match.botId : undefined;
  const byPin = new Map(bots.data?.map((bot) => [botPin(bot.id), bot]));
  const pinned = pins.pinned.flatMap((key) => byPin.get(key) ?? []);

  const unpinned =
    bots.data?.filter((bot) => !pins.isPinned(botPin(bot.id))) ?? [];

  return (
    <Sidebar variant="inset">
      <SidebarHeader className="h-12 flex-row items-center gap-1">
        <span className={WORDMARK}>
          <CrumbleMark className="size-5" />
          Crumble
        </span>
        <button
          type="button"
          title="Search"
          aria-label="Search"
          className={cn(ICON_BUTTON, "md:hidden")}
          onClick={onSearch}
        >
          <IconSearch />
        </button>
        <HeaderLink item={ACTIVITY} />
        <HeaderLink item={SETTINGS} />
      </SidebarHeader>
      <ConnectionNote />
      <PinnedBots bots={pinned} pins={pins} activeId={activeId} />
      <SidebarContent className="gap-0">
        <AutomationsRow />
        <BotsSection
          bots={bots}
          unpinned={unpinned}
          pins={pins}
          activeId={activeId}
        />
      </SidebarContent>
    </Sidebar>
  );
}
