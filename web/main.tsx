import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import {
  Link,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useMatchRoute,
  useNavigate,
  Outlet,
} from "@tanstack/react-router";
import {
  ActivityIcon,
  BotIcon,
  BrainIcon,
  CalendarClockIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  type Bot,
  HttpError,
  api,
  botsQuery,
  chatQuery,
  groupChatQuery,
  groupsQuery,
  queryClient,
  token,
} from "./api";
import { ActivityPage } from "./activity";
import { BotAvatar } from "./avatar";
import { BotForm } from "./bot-form";
import { Chat } from "./chat";
import { BotDesktop } from "./desktop";
import { GroupChatView, GroupForm } from "./groups";
import { IntegrationsPage, OAuthCallback } from "./integrations";
import { followActivity, useConnectionStatus, useWorking } from "./live";
import { MemoryPage } from "./memory";
import { GeneralSettings, ProvidersSettings, SettingsLayout } from "./settings";
import { SkillsPage } from "./skills";
import { TasksPage } from "./tasks";

const rootRoute = createRootRoute();

const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connect",
  component: Connect,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: () => {
    if (!token.get()) throw redirect({ to: "/connect" });
  },
  component: Shell,
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: Home,
});

const newBotRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/bots/new",
  component: () => <BotForm />,
});

const botRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/bots/$botId",
  loader: ({ params }) => queryClient.ensureQueryData(chatQuery(params.botId)),
  component: function BotPage() {
    const { botId } = botRoute.useParams();

    return <Chat key={botId} botId={botId} />;
  },
});

const editBotRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/bots/$botId/edit",
  loader: () => queryClient.ensureQueryData(botsQuery),
  component: function EditBotPage() {
    const { botId } = editBotRoute.useParams();
    const bot = useQuery(botsQuery).data?.find((each) => each.id === botId);

    return bot ? (
      <BotForm key={bot.id} bot={bot} />
    ) : (
      <p className="m-auto text-muted-foreground">Bot not found.</p>
    );
  },
});

const desktopRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/bots/$botId/desktop",
  component: function DesktopPage() {
    const { botId } = desktopRoute.useParams();

    return <BotDesktop key={botId} botId={botId} />;
  },
});

const newGroupRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/groups/new",
  component: () => <GroupForm />,
});

const groupRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/groups/$groupId",
  loader: ({ params }) =>
    queryClient.ensureQueryData(groupChatQuery(params.groupId)),
  component: function GroupPage() {
    const { groupId } = groupRoute.useParams();

    return <GroupChatView key={groupId} groupId={groupId} />;
  },
});

const editGroupRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/groups/$groupId/edit",
  loader: () => queryClient.ensureQueryData(groupsQuery),
  component: function EditGroupPage() {
    const { groupId } = editGroupRoute.useParams();

    const group = useQuery(groupsQuery).data?.find(
      (each) => each.id === groupId,
    );

    return group ? (
      <GroupForm key={group.id} group={group} />
    ) : (
      <p className="m-auto text-muted-foreground">Group chat not found.</p>
    );
  },
});

const memoryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/memory",
  component: MemoryPage,
});

// Skills and integrations moved into settings; old links still land there.
const skillsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/skills",
  beforeLoad: () => {
    throw redirect({ to: "/settings/skills", replace: true });
  },
});

const tasksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tasks",
  component: TasksPage,
});

const activityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/activity",
  component: ActivityPage,
});

const integrationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations",
  beforeLoad: () => {
    throw redirect({ to: "/settings/integrations", replace: true });
  },
});

const oauthRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/oauth/callback",
  component: OAuthCallback,
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/general", replace: true });
  },
});

const generalRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/general",
  component: GeneralSettings,
});

const providersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/providers",
  component: ProvidersSettings,
});

const settingsIntegrationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/integrations",
  component: IntegrationsPage,
});

const settingsSkillsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/skills",
  component: SkillsPage,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    connectRoute,
    appRoute.addChildren([
      indexRoute,
      newBotRoute,
      botRoute,
      editBotRoute,
      desktopRoute,
      newGroupRoute,
      groupRoute,
      editGroupRoute,
      memoryRoute,
      skillsRoute,
      tasksRoute,
      activityRoute,
      integrationsRoute,
      oauthRoute,
      settingsRoute.addChildren([
        settingsIndexRoute,
        generalRoute,
        providersRoute,
        settingsIntegrationsRoute,
        settingsSkillsRoute,
      ]),
    ]),
  ]),
  basepath: "/ui",
  defaultPreload: "intent",
  // Query owns caching; the router only triggers loads.
  defaultPreloadStaleTime: 0,
  defaultErrorComponent: ({ error }) => (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>
          {error instanceof HttpError && error.status === 404
            ? "Not found"
            : "Something went wrong"}
        </EmptyTitle>
        <EmptyDescription>
          {error instanceof Error ? error.message : null}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button render={<Link to="/" />} nativeButton={false} variant="outline">
          Go home
        </Button>
      </EmptyContent>
    </Empty>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

token.subscribe(() => {
  if (!token.get()) void router.navigate({ to: "/connect" });
});

function Connect() {
  const [value, setValue] = useState("");
  const navigate = useNavigate();

  const connect = useMutation({
    mutationFn: async (candidate: string) => {
      token.set(candidate);
      await api("/v1/capabilities");
    },
    onSuccess: () => navigate({ to: "/" }),
  });

  return (
    <form
      className="mx-auto mt-[20vh] w-full max-w-xs px-4"
      onSubmit={(event) => {
        event.preventDefault();
        connect.mutate(value.trim());
      }}
    >
      <FieldGroup>
        <h1 className="font-heading text-xl font-semibold">Crumble</h1>
        <Field data-invalid={connect.isError || undefined}>
          <FieldLabel htmlFor="token">Server token</FieldLabel>
          <Input
            id="token"
            type="password"
            autoFocus
            autoComplete="current-password"
            aria-invalid={connect.isError || undefined}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {connect.isError && <FieldError>{connect.error.message}</FieldError>}
        </Field>
        <Button type="submit" disabled={!value.trim() || connect.isPending}>
          Connect
        </Button>
      </FieldGroup>
    </form>
  );
}

const WORKSPACE = [
  { to: "/memory", label: "Memory", icon: BrainIcon },
  { to: "/tasks", label: "Tasks", icon: CalendarClockIcon },
  { to: "/activity", label: "Activity", icon: ActivityIcon },
] as const;

function Shell() {
  const bots = useQuery(botsQuery);
  const groups = useQuery(groupsQuery);
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();

  useEffect(() => {
    const controller = new AbortController();

    followActivity(({ botId, groupId }) => {
      if (groupId)
        void navigate({ to: "/groups/$groupId", params: { groupId } });
      else if (botId) void navigate({ to: "/bots/$botId", params: { botId } });
    }, controller.signal);

    return () => controller.abort();
  }, [navigate]);

  const shownBots = (bots.data ?? []).filter(
    (bot) =>
      !needle ||
      bot.name.toLowerCase().includes(needle) ||
      bot.lastMessage?.toLowerCase().includes(needle),
  );

  const shownGroups = (groups.data ?? []).filter(
    (group) => !needle || group.name.toLowerCase().includes(needle),
  );

  const byId = new Map(bots.data?.map((bot) => [bot.id, bot]));

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <span className="px-2 font-heading font-semibold">Crumble</span>
            <SidebarInput
              placeholder="Search"
              aria-label="Search bots and group chats"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Bots</SidebarGroupLabel>
              <SidebarGroupAction
                title="New bot"
                render={<Link to="/bots/new" />}
              >
                <PlusIcon />
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
                  <p className="px-2 text-xs text-destructive">
                    {bots.error.message}
                  </p>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Group chats</SidebarGroupLabel>
              {(bots.data?.length ?? 0) >= 2 && (
                <SidebarGroupAction
                  title="New group chat"
                  render={<Link to="/groups/new" />}
                >
                  <PlusIcon />
                  <span className="sr-only">New group chat</span>
                </SidebarGroupAction>
              )}
              <SidebarGroupContent>
                <SidebarMenu>
                  {shownGroups.map((group) => {
                    const members = group.memberIds.flatMap((id) => {
                      const member = byId.get(id);

                      return member ? [member] : [];
                    });

                    return (
                      <SidebarMenuItem key={group.id}>
                        <SidebarMenuButton
                          size="lg"
                          isActive={Boolean(
                            matchRoute({
                              to: "/groups/$groupId",
                              params: { groupId: group.id },
                              fuzzy: true,
                            }),
                          )}
                          render={
                            <Link
                              to="/groups/$groupId"
                              params={{ groupId: group.id }}
                            />
                          }
                        >
                          <span className="flex shrink-0 -space-x-3">
                            {members.slice(0, 2).map((member) => (
                              <BotAvatar
                                key={member.id}
                                bot={member}
                                size={26}
                              />
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
                  })}
                  {groups.data?.length === 0 && (
                    <p className="px-2 text-xs text-muted-foreground">
                      {(bots.data?.length ?? 0) >= 2
                        ? "No group chats yet"
                        : "Create two bots to start a group chat"}
                    </p>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
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
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={Boolean(
                    matchRoute({ to: "/settings", fuzzy: true }),
                  )}
                  render={<Link to="/settings" />}
                >
                  <SettingsIcon />
                  Settings
                  <ConnectionStatus />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="h-dvh min-w-0">
          <header className="flex h-12 shrink-0 items-center px-2 md:hidden">
            <SidebarTrigger />
          </header>
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
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

  const chip = !bot.enabled
    ? "Paused"
    : bot.description.length <= 24
      ? bot.description
      : "";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={active}
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
          <span className="flex items-center gap-1.5">
            <span className={cn("truncate", !bot.enabled && "opacity-60")}>
              {bot.name}
            </span>
            {chip && (
              <span className="truncate text-[10px] text-muted-foreground">
                {chip}
              </span>
            )}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {working
              ? "Working…"
              : bot.lastMessage
                ? bot.lastMessage.replace(/[*_`#>]/g, "").slice(0, 120)
                : "No messages yet"}
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function Home() {
  const bots = useQuery(botsQuery);
  const empty = bots.data?.length === 0;

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BotIcon />
        </EmptyMedia>
        <EmptyTitle>
          {bots.isPending
            ? "Opening your workspace"
            : empty
              ? "A little help, always here."
              : "Choose a bot"}
        </EmptyTitle>
        <EmptyDescription>
          {empty
            ? "Create a bot to start chatting."
            : "Pick a bot or group chat from the sidebar."}
        </EmptyDescription>
      </EmptyHeader>
      {empty && (
        <EmptyContent>
          <Button render={<Link to="/bots/new" />} nativeButton={false}>
            <PlusIcon data-icon="inline-start" />
            Create a bot
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
