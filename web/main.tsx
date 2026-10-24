import { StrictMode, useEffect, useRef, useState } from "react";
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
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Activity01Icon,
  BotIcon,
  BrainIcon,
  Calendar03Icon,
  PlusSignIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  type Bot,
  HttpError,
  botsQuery,
  chatQuery,
  groupChatQuery,
  groupsQuery,
  queryClient,
  clearUserData,
} from "./api";
import { authClient } from "./auth-client";
import { ActivityPage } from "./activity";
import { BotAvatar, botColor, botStyle } from "./avatar";
import { BotForm } from "./bot-form";
import { Chat } from "./chat";
import { CredentialsPage } from "./credentials";
import { BotDesktop } from "./desktop";
import { GroupChatView, GroupForm } from "./groups";
import { IntegrationsPage, OAuthCallback } from "./integrations";
import {
  clearLiveStreams,
  followActivity,
  useConnectionStatus,
  useWorking,
} from "./live";
import { MemoryPage } from "./memory";
import { GeneralSettings, ProvidersSettings, SettingsLayout } from "./settings";
import { SkillsPage } from "./skills";
import { TasksPage } from "./tasks";

const rootRoute = createRootRoute();

const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connect",
  beforeLoad: async () => {
    const session = await authClient.getSession();

    if (session.data) throw redirect({ to: "/" });
  },
  component: Connect,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async () => {
    const session = await authClient.getSession();

    if (!session.data) throw redirect({ to: "/connect" });
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

const credentialsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/bots/$botId/credentials",
  component: function BotCredentialsPage() {
    const { botId } = credentialsRoute.useParams();

    return <CredentialsPage key={botId} botId={botId} />;
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
      credentialsRoute,
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
  defaultViewTransition: true,
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

function Connect() {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  const connect = useMutation({
    mutationFn: async () => {
      const result =
        mode === "sign-in"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name });

      if (result.error) throw new Error(result.error.message);
    },
    onSuccess: async () => {
      clearUserData();
      window.location.assign("/ui/");
    },
  });

  return (
    <form
      className="mx-auto mt-[20vh] w-full max-w-xs px-4"
      onSubmit={(event) => {
        event.preventDefault();
        connect.mutate();
      }}
    >
      <FieldGroup>
        <h1 className="font-heading text-xl font-semibold">Crumble</h1>
        {mode === "sign-up" && (
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        )}
        <Field data-invalid={connect.isError || undefined}>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            type="email"
            autoFocus
            autoComplete="email"
            aria-invalid={connect.isError || undefined}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field data-invalid={connect.isError || undefined}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete={
              mode === "sign-in" ? "current-password" : "new-password"
            }
            aria-invalid={connect.isError || undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {connect.isError && <FieldError>{connect.error.message}</FieldError>}
        </Field>
        <Button
          type="submit"
          disabled={
            !email.trim() ||
            !password ||
            (mode === "sign-up" && !name.trim()) ||
            connect.isPending
          }
        >
          {mode === "sign-in" ? "Sign in" : "Create account"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            connect.reset();
          }}
        >
          {mode === "sign-in"
            ? "Create an account"
            : "Already have an account? Sign in"}
        </Button>
      </FieldGroup>
    </form>
  );
}

const WORKSPACE = [
  { to: "/memory", label: "Memory", icon: BrainIcon },
  { to: "/tasks", label: "Tasks", icon: Calendar03Icon },
  { to: "/activity", label: "Activity", icon: Activity01Icon },
] as const;

function Shell() {
  const session = authClient.useSession();
  const bots = useQuery(botsQuery);
  const groups = useQuery(groupsQuery);
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const userId = session.data?.user.id;
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
            <SidebarGroup>
              <SidebarGroupLabel>Bots</SidebarGroupLabel>
              <SidebarGroupAction
                title="New bot"
                render={<Link to="/bots/new" />}
              >
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
                  <HugeiconsIcon icon={PlusSignIcon} />
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
                        <HugeiconsIcon icon={item.icon} />
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
                  <HugeiconsIcon icon={Settings01Icon} />
                  Settings
                  <ConnectionStatus />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
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

function greeting(hour: number) {
  if (hour < 5) return "Up late";

  if (hour < 12) return "Good morning";

  if (hour < 18) return "Good afternoon";

  return "Good evening";
}

function Home() {
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
                <HugeiconsIcon icon={PlusSignIcon} className="size-6" />
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
          <HugeiconsIcon icon={BotIcon} />
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
            <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
