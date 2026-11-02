import { useEffect, useRef, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  Link,
  useMatchRoute,
  useNavigate,
  useRouterState,
  Outlet,
} from "@tanstack/react-router";
import { IconPlus, IconSearch, IconSettings } from "@tabler/icons-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CrumbleMark } from "@/components/crumble-mark";
import { cn } from "@/lib/utils";
import {
  type Bot,
  type GroupChat,
  botsQuery,
  groupsQuery,
  clearUserData,
} from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import {
  THEME_COLOR,
  isDark,
  setTheme,
  useAccountTheme,
  useTheme,
} from "@/lib/theme";
import {
  clearLiveStreams,
  followActivity,
  markSeen,
  useConnectionStatus,
  useUnreadCount,
  useWorking,
} from "@/lib/live";
import {
  BotAvatar,
  LiveBotAvatar,
  botColor,
  botStyle,
} from "@/features/bots/avatar";
import { CommandPalette, PALETTE_SHORTCUT } from "./command-palette";
import { THEME_OPTIONS, WORKSPACE } from "./navigation";

function useResetOnUserChange(userId: string | undefined) {
  const previousUserId = useRef(userId);

  useEffect(() => {
    if (
      previousUserId.current !== undefined &&
      previousUserId.current !== userId
    ) {
      clearLiveStreams();
      clearUserData();

      if (!userId) window.location.assign("/connect");
    }

    previousUserId.current = userId;
  }, [userId]);
}

function useFollowActivity() {
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });

  useEffect(markSeen, [path]);

  useEffect(() => {
    const controller = new AbortController();

    followActivity(({ botId, groupId }) => {
      if (groupId)
        void navigate({ to: "/groups/$groupId", params: { groupId } });
      else if (botId) void navigate({ to: "/bots/$botId", params: { botId } });
    }, controller.signal);

    return () => controller.abort();
  }, [navigate]);
}

/** Titles the tab with the unseen replies and the open chat, such as `(3) Atlas | Crumble`. */
function useDocumentTitle(
  bots: Bot[] | undefined,
  groups: GroupChat[] | undefined,
) {
  const matchRoute = useMatchRoute();
  const unread = useUnreadCount();
  const bot = matchRoute({ to: "/bots/$botId" });
  const group = matchRoute({ to: "/groups/$groupId" });

  const chat = bot
    ? bots?.find(({ id }) => id === bot.botId)?.name
    : group
      ? groups?.find(({ id }) => id === group.groupId)?.name
      : undefined;

  useEffect(() => {
    const title = chat ? `${chat} | Crumble` : "Crumble";

    document.title = unread ? `(${unread}) ${title}` : title;
  }, [chat, unread]);
}

/** The sidebar's background, as `--sidebar` in styles.css, per color scheme. */
const SIDEBAR_THEME_COLOR = { light: "#e4e6ea", dark: "#030304" };

/**
 * Tints the browser chrome, which in an installed iPhone app is the status
 * bar, to match the sidebar sheet while it is open on phones.
 */
function SidebarThemeColor() {
  const { isMobile, openMobile } = useSidebar();
  const theme = useTheme();
  const tinted = isMobile && openMobile;

  useEffect(() => {
    if (!tinted) return;

    const metas = [
      ...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
    ];

    for (const meta of metas)
      meta.content = isDark()
        ? SIDEBAR_THEME_COLOR.dark
        : SIDEBAR_THEME_COLOR.light;

    return () => {
      for (const meta of metas)
        meta.content = isDark() ? THEME_COLOR.dark : THEME_COLOR.light;
    };
  }, [tinted, theme]);

  return null;
}

export function Shell() {
  const session = authClient.useSession();
  const bots = useQuery(botsQuery);
  const groups = useQuery(groupsQuery);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useResetOnUserChange(session.data?.user.id);
  useFollowActivity();
  useDocumentTitle(bots.data, groups.data);
  useAccountTheme();

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar variant="inset">
          <SidebarHeader>
            <span className="flex items-center gap-2 px-2 pt-1 pb-2 font-heading text-lg font-semibold tracking-tight">
              <CrumbleMark className="size-5" />
              Crumble
            </span>
            <SearchButton onOpen={() => setPaletteOpen(true)} />
          </SidebarHeader>
          <SidebarContent>
            <BotsSection bots={bots} />
            <GroupsSection bots={bots.data} groups={groups.data} />
            <WorkspaceSection />
          </SidebarContent>
          <SettingsFooter />
        </Sidebar>
        <SidebarThemeColor />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <SidebarInset className="group/inset h-dvh min-w-0 overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] md:peer-data-[state=expanded]:pl-0 md:h-[calc(100dvh-1rem)] md:shadow-sm md:ring-1 md:ring-sidebar-border dark:md:shadow-none">
          <header className="flex h-12 shrink-0 items-center px-2 group-has-[[data-page-trigger]]/inset:hidden md:hidden">
            <SidebarTrigger className="size-9" />
          </header>
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function BotsSection({ bots }: { bots: UseQueryResult<Bot[]> }) {
  const matchRoute = useMatchRoute();

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
          {bots.data?.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              active={Boolean(
                matchRoute({
                  to: "/bots/$botId",
                  params: { botId: bot.id },
                  fuzzy: true,
                }),
              )}
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

function GroupsSection({
  bots,
  groups,
}: {
  bots: Bot[] | undefined;
  groups: GroupChat[] | undefined;
}) {
  const byId = new Map(bots?.map((bot) => [bot.id, bot]));
  const canGroup = (bots?.length ?? 0) >= 2;

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Group chats</SidebarGroupLabel>
      {canGroup && (
        <SidebarGroupAction
          title="New group chat"
          render={<Link to="/groups/new" />}
        >
          <IconPlus />
          <span className="sr-only">New group chat</span>
        </SidebarGroupAction>
      )}
      <SidebarGroupContent>
        <SidebarMenu>
          {groups?.map((group) => (
            <GroupRow
              key={group.id}
              group={group}
              members={group.memberIds.flatMap((id) => {
                const member = byId.get(id);

                return member ? [member] : [];
              })}
            />
          ))}
          {groups?.length === 0 && (
            <p className="px-2 text-xs text-muted-foreground">
              {canGroup
                ? "No group chats yet"
                : "Create two bots to start a group chat"}
            </p>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function GroupRow({ group, members }: { group: GroupChat; members: Bot[] }) {
  const matchRoute = useMatchRoute();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={Boolean(
          matchRoute({
            to: "/groups/$groupId",
            params: { groupId: group.id },
            fuzzy: true,
          }),
        )}
        render={<Link to="/groups/$groupId" params={{ groupId: group.id }} />}
      >
        <span className="flex shrink-0 -space-x-3">
          {members.slice(0, 2).map((member) => (
            <BotAvatar key={member.id} bot={member} size={26} />
          ))}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{group.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {members.map((member) => member.name).join(", ")}
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function WorkspaceSection() {
  const matchRoute = useMatchRoute();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Workspace</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {WORKSPACE.map((item) => (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton
                isActive={Boolean(matchRoute({ to: item.to }))}
                render={<Link to={item.to} />}
              >
                <item.icon />
                {item.label}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function SettingsFooter() {
  const matchRoute = useMatchRoute();

  return (
    <SidebarFooter>
      <SidebarMenu>
        <ThemeMenu />
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={Boolean(matchRoute({ to: "/settings", fuzzy: true }))}
            render={<Link to="/settings" />}
          >
            <IconSettings />
            Settings
            <ConnectionStatus />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

function ThemeMenu() {
  const theme = useTheme();

  const current =
    THEME_OPTIONS.find(({ value }) => value === theme) ?? THEME_OPTIONS[0];

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger render={<SidebarMenuButton />}>
          <current.icon />
          Theme
          <span className="ml-auto text-xs text-muted-foreground">
            {current.label}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-40">
          <DropdownMenuRadioGroup
            value={theme}
            onValueChange={(value) => {
              const option = THEME_OPTIONS.find((item) => item.value === value);

              if (option) void setTheme(option.value);
            }}
          >
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
              <DropdownMenuRadioItem key={value} value={value} closeOnClick>
                <Icon />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function SearchButton({ onOpen }: { onOpen: () => void }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          aria-keyshortcuts="Meta+K"
          className="text-muted-foreground"
          onClick={onOpen}
        >
          <IconSearch />
          Search
          <kbd className="pointer-events-none ml-auto hidden rounded border bg-muted px-1 font-sans text-[10px] md:inline">
            {PALETTE_SHORTCUT}
          </kbd>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function ConnectionStatus() {
  const status = useConnectionStatus();

  if (status === "connected") return null;

  return (
    <span className="ml-auto text-xs text-destructive">
      {status === "reconnecting" ? "Reconnecting…" : "Disconnected"}
    </span>
  );
}

function BotRow({ bot, active }: { bot: Bot; active: boolean }) {
  const working = useWorking(bot.id);

  return (
    <SidebarMenuItem style={botStyle(botColor(bot))}>
      <SidebarMenuButton
        size="lg"
        isActive={active}
        className="h-auto py-1.5 data-active:bg-bot-soft!"
        render={<Link to="/bots/$botId" params={{ botId: bot.id }} />}
      >
        <LiveBotAvatar bot={bot} size={36} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate font-heading font-medium",
              !bot.enabled && "opacity-60",
            )}
          >
            {bot.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {working
              ? "Working…"
              : !bot.enabled
                ? "Paused"
                : bot.lastMessage
                  ? bot.lastMessage.replace(/[*_`#>]/g, "").slice(0, 120)
                  : bot.description || "No messages yet"}
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
