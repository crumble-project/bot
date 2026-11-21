import { type ComponentProps, useEffect, useRef, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  Link,
  useMatchRoute,
  useNavigate,
  useRouter,
  useRouterState,
  Outlet,
} from "@tanstack/react-router";
import {
  IconDots,
  IconPin,
  IconPinnedOff,
  IconPlus,
  IconSearch,
  IconSettings,
} from "@tabler/icons-react";
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
  SidebarMenuAction,
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
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CrumbleMark } from "@/components/crumble-mark";
import { cn, numberWord, plainMarkdown } from "@/lib/utils";
import { type Bot, botsQuery } from "@/features/bots/api";
import {
  type GroupChat,
  groupsQuery,
  membersOf,
} from "@/features/group-chats/api";
import { authClient } from "@/lib/auth-client";
import {
  setTheme,
  setThemeColor,
  useAccountTheme,
  useTheme,
} from "@/lib/theme";
import { resetSession, signedOut } from "@/lib/session";
import { botPin, groupPin, type Pins, usePins } from "@/lib/pins";
import { botStatusLine, isBusy, useWorking } from "@/features/bot-chat/working";
import { followActivity, useConnectionStatus } from "./activity-stream";
import { markSeen, useUnreadCount } from "@/lib/notifications";
import { BotAvatar, botColor, botStyle } from "@/components/bot-avatar";
import { LiveBotAvatar } from "@/features/bot-chat/avatar";
import { CommandPalette, PALETTE_SHORTCUT } from "./command-palette";
import { THEME_OPTIONS, PAGES } from "./navigation";
import { MIN_GROUP_MEMBERS } from "@crumble/server/contract/limits";
import type { ReplyChat } from "@/lib/notifications";

function useResetOnUserChange(userId: string | undefined) {
  const previousUserId = useRef(userId);
  const navigate = useNavigate();

  useEffect(() => {
    if (
      previousUserId.current !== undefined &&
      previousUserId.current !== userId
    ) {
      if (!userId) signedOut();
      else {
        resetSession();
        void navigate({ to: "/" });
      }
    }

    previousUserId.current = userId;
  }, [navigate, userId]);
}

const chatLocation = ({ kind, id }: ReplyChat) =>
  kind === "group"
    ? ({ to: "/groups/$groupId", params: { groupId: id } } as const)
    : ({ to: "/bots/$botId", params: { botId: id } } as const);

function useFollowActivity(userId: string | undefined) {
  const navigate = useNavigate();
  const router = useRouter();
  const path = useRouterState({ select: (state) => state.location.pathname });

  useEffect(markSeen, [path]);

  useEffect(() => {
    if (!userId) return;

    const controller = new AbortController();

    followActivity(
      {
        open: (chat) => void navigate(chatLocation(chat)),
        pathOf: (chat) => router.buildLocation(chatLocation(chat)).pathname,
      },
      controller.signal,
    );

    return () => controller.abort();
  }, [navigate, router, userId]);
}

function useDocumentTitle(
  bots: Bot[] | undefined,
  groups: GroupChat[] | undefined,
) {
  const matchRoute = useMatchRoute();
  const unread = useUnreadCount();
  const bot = matchRoute({ to: "/bots/$botId" });
  const group = matchRoute({ to: "/groups/$groupId" });

  const groupName = group
    ? groups?.find(({ id }) => id === group.groupId)?.name
    : undefined;

  const chat = bot ? bots?.find(({ id }) => id === bot.botId)?.name : groupName;

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

    setThemeColor(SIDEBAR_THEME_COLOR);

    return () => setThemeColor();
  }, [tinted, theme]);

  return null;
}

export function Shell() {
  const session = authClient.useSession();
  const bots = useQuery(botsQuery);
  const groups = useQuery(groupsQuery);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pins = usePins(bots.data, groups.data);
  const userId = session.data?.user.id;
  useResetOnUserChange(userId);
  useFollowActivity(userId);
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
            <PinnedSection pins={pins} bots={bots.data} groups={groups.data} />
            <BotsSection bots={bots} pins={pins} />
            <GroupsSection bots={bots.data} groups={groups.data} pins={pins} />
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

type DragProps = Pick<
  ComponentProps<"li">,
  "draggable" | "onDragStart" | "onDragOver" | "onDrop" | "onDragEnd"
>;

function PinnedSection({
  pins,
  bots,
  groups,
}: {
  pins: Pins;
  bots: Bot[] | undefined;
  groups: GroupChat[] | undefined;
}) {
  const matchRoute = useMatchRoute();
  const dragged = useRef<string | null>(null);

  if (pins.pinned.length === 0) return null;

  const botsById = new Map(bots?.map((bot) => [bot.id, bot]));
  const botsByPin = new Map(bots?.map((bot) => [botPin(bot.id), bot]));

  const groupsByPin = new Map(
    groups?.map((group) => [groupPin(group.id), group]),
  );

  const drag = (key: string): DragProps => ({
    draggable: true,
    onDragStart: (event) => {
      dragged.current = key;
      event.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (event) => {
      if (!dragged.current || dragged.current === key) return;

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDrop: (event) => {
      event.preventDefault();

      if (dragged.current) pins.move(dragged.current, key);

      dragged.current = null;
    },
    onDragEnd: () => {
      dragged.current = null;
    },
  });

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Pinned</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {pins.pinned.map((key) => {
            const bot = botsByPin.get(key);
            const group = groupsByPin.get(key);

            if (bot)
              return (
                <BotRow
                  key={key}
                  bot={bot}
                  active={Boolean(
                    matchRoute({
                      to: "/bots/$botId",
                      params: { botId: bot.id },
                      fuzzy: true,
                    }),
                  )}
                  pins={pins}
                  drag={drag(key)}
                />
              );

            return (
              group && (
                <GroupRow
                  key={key}
                  group={group}
                  members={membersOf(group.memberIds, botsById)}
                  pins={pins}
                  drag={drag(key)}
                />
              )
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function PinAction({
  conversation,
  pins,
}: {
  conversation: string;
  pins: Pins;
}) {
  if (!pins.ready) return null;

  const pinned = pins.isPinned(conversation);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<SidebarMenuAction showOnHover title="More" />}
      >
        <IconDots />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        <DropdownMenuItem
          disabled={!pinned && !pins.canPin(conversation)}
          onClick={() =>
            pinned ? pins.unpin(conversation) : pins.pin(conversation)
          }
        >
          {pinned ? <IconPinnedOff /> : <IconPin />}
          {pinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BotsSection({
  bots,
  pins,
}: {
  bots: UseQueryResult<Bot[]>;
  pins: Pins;
}) {
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
          {bots.data
            ?.filter((bot) => !pins.isPinned(botPin(bot.id)))
            .map((bot) => (
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

function GroupsSection({
  bots,
  groups,
  pins,
}: {
  bots: Bot[] | undefined;
  groups: GroupChat[] | undefined;
  pins: Pins;
}) {
  const byId = new Map(bots?.map((bot) => [bot.id, bot]));
  const canGroup = (bots?.length ?? 0) >= MIN_GROUP_MEMBERS;

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
          {groups
            ?.filter((group) => !pins.isPinned(groupPin(group.id)))
            .map((group) => (
              <GroupRow
                key={group.id}
                group={group}
                members={membersOf(group.memberIds, byId)}
                pins={pins}
              />
            ))}
          {groups?.length === 0 && (
            <p className="px-2 text-xs text-muted-foreground">
              {canGroup
                ? "No group chats yet"
                : `Create ${numberWord(MIN_GROUP_MEMBERS)} bots to start a group chat`}
            </p>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function GroupRow({
  group,
  members,
  pins,
  drag,
}: {
  group: GroupChat;
  members: Bot[];
  pins: Pins;
  drag?: DragProps;
}) {
  const matchRoute = useMatchRoute();

  return (
    <SidebarMenuItem {...drag}>
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
      <PinAction conversation={groupPin(group.id)} pins={pins} />
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
          {PAGES.map((item) => (
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

function BotRow({
  bot,
  active,
  pins,
  drag,
}: {
  bot: Bot;
  active: boolean;
  pins: Pins;
  drag?: DragProps;
}) {
  const working = isBusy(useWorking(bot.id));

  return (
    <SidebarMenuItem style={botStyle(botColor(bot))} {...drag}>
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
            {botStatusLine(
              bot,
              working,
              bot.lastMessage
                ? plainMarkdown(bot.lastMessage).slice(0, 120)
                : bot.description || "No messages yet",
            )}
          </span>
        </span>
      </SidebarMenuButton>
      <PinAction conversation={botPin(bot.id)} pins={pins} />
    </SidebarMenuItem>
  );
}
