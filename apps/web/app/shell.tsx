import { useEffect, useRef, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  Link,
  useMatchRoute,
  useNavigate,
  Outlet,
} from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Activity01Icon,
  BrainIcon,
  Calendar03Icon,
  PlusSignIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
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
  clearLiveStreams,
  followActivity,
  useConnectionStatus,
  useWorking,
} from "@/lib/live";
import { BotAvatar, botColor, botStyle } from "@/features/bots/avatar";

const WORKSPACE = [
  { to: "/memory", label: "Memory", icon: BrainIcon },
  { to: "/tasks", label: "Tasks", icon: Calendar03Icon },
  { to: "/activity", label: "Activity", icon: Activity01Icon },
] as const;

function useResetOnUserChange(userId: string | undefined) {
  const previousUserId = useRef(userId);

  useEffect(() => {
    if (
      previousUserId.current !== undefined &&
      previousUserId.current !== userId
    ) {
      clearLiveStreams();
      clearUserData();

      if (!userId) window.location.assign("/ui/connect");
    }

    previousUserId.current = userId;
  }, [userId]);
}

function useFollowActivity() {
  const navigate = useNavigate();

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

function matchesBot(bot: Bot, needle: string) {
  return (
    !needle ||
    bot.name.toLowerCase().includes(needle) ||
    bot.lastMessage?.toLowerCase().includes(needle)
  );
}

export function Shell() {
  const session = authClient.useSession();
  const bots = useQuery(botsQuery);
  const groups = useQuery(groupsQuery);
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  useResetOnUserChange(session.data?.user.id);
  useFollowActivity();
  const needle = search.trim().toLowerCase();

  const shownBots = (bots.data ?? []).filter((bot) => matchesBot(bot, needle));

  const shownGroups = (groups.data ?? []).filter(
    (group) => !needle || group.name.toLowerCase().includes(needle),
  );

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar variant="inset">
          <SidebarHeader>
            <span className="px-2 pt-1 pb-2 font-heading text-lg font-semibold tracking-tight">
              Crumble
            </span>
            <SidebarSearch
              value={search}
              onChange={setSearch}
              onOpenFirst={() => {
                const [bot] = shownBots;
                const [group] = shownGroups;

                if (bot)
                  void navigate({
                    to: "/bots/$botId",
                    params: { botId: bot.id },
                  });
                else if (group)
                  void navigate({
                    to: "/groups/$groupId",
                    params: { groupId: group.id },
                  });
              }}
            />
          </SidebarHeader>
          <SidebarContent>
            <BotsSection bots={bots} shownBots={shownBots} needle={needle} />
            <GroupsSection
              bots={bots.data}
              groups={groups.data}
              shownGroups={shownGroups}
            />
            <WorkspaceSection />
          </SidebarContent>
          <SettingsFooter />
        </Sidebar>
        <SidebarInset className="h-dvh min-w-0 overflow-hidden md:h-[calc(100dvh-1rem)] md:ring-1 md:ring-sidebar-border">
          <header className="flex h-12 shrink-0 items-center px-2 md:hidden">
            <SidebarTrigger />
          </header>
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function BotsSection({
  bots,
  shownBots,
  needle,
}: {
  bots: UseQueryResult<Bot[]>;
  shownBots: Bot[];
  needle: string;
}) {
  const matchRoute = useMatchRoute();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Bots</SidebarGroupLabel>
      <SidebarGroupAction title="New bot" render={<Link to="/bots/new" />}>
        <HugeiconsIcon icon={PlusSignIcon} />
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
          {shownBots.map((bot) => (
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
          {bots.data && shownBots.length === 0 && (
            <p className="px-2 text-xs text-muted-foreground">
              {needle ? "No results" : "No bots yet"}
            </p>
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
  shownGroups,
}: {
  bots: Bot[] | undefined;
  groups: GroupChat[] | undefined;
  shownGroups: GroupChat[];
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
          <HugeiconsIcon icon={PlusSignIcon} />
          <span className="sr-only">New group chat</span>
        </SidebarGroupAction>
      )}
      <SidebarGroupContent>
        <SidebarMenu>
          {shownGroups.map((group) => (
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
                <HugeiconsIcon icon={item.icon} />
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
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={Boolean(matchRoute({ to: "/settings", fuzzy: true }))}
            render={<Link to="/settings" />}
          >
            <HugeiconsIcon icon={Settings01Icon} />
            Settings
            <ConnectionStatus />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

const SEARCH_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent)
  ? "⌘K"
  : "Ctrl K";

function SidebarSearch({
  value,
  onChange,
  onOpenFirst,
}: {
  value: string;
  onChange: (value: string) => void;
  onOpenFirst: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { isMobile, setOpen, setOpenMobile } = useSidebar();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "k" || !(event.metaKey || event.ctrlKey)) return;

      event.preventDefault();

      if (isMobile) setOpenMobile(true);
      else setOpen(true);
      // The sidebar may still be sliding in; focus once it is laid out.
      requestAnimationFrame(() => input.current?.select());
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobile, setOpen, setOpenMobile]);

  return (
    <div className="relative">
      <SidebarInput
        ref={input}
        placeholder="Search"
        aria-label="Search bots and group chats"
        aria-keyshortcuts="Meta+K"
        className="pr-10"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onChange("");
            event.currentTarget.blur();
          } else if (event.key === "Enter" && value.trim()) {
            onOpenFirst();
            onChange("");
            event.currentTarget.blur();
          }
        }}
      />
      {!value && (
        <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border bg-muted px-1 font-sans text-[10px] text-muted-foreground md:inline">
          {SEARCH_SHORTCUT}
        </kbd>
      )}
    </div>
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
        <BotAvatar
          bot={bot}
          size={36}
          live
          state={
            working ? "working" : bot.enabled && active ? "idle" : "sleeping"
          }
        />
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
