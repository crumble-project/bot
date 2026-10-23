import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useMatchRoute,
  useNavigate,
} from "@tanstack/react-router";
import { BotIcon, LogOutIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, botsQuery, chatQuery, queryClient, token } from "./api";
import { BotForm } from "./bot-form";
import { Chat } from "./chat";
import { Settings } from "./settings";

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

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: Settings,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    connectRoute,
    appRoute.addChildren([
      indexRoute,
      newBotRoute,
      botRoute,
      editBotRoute,
      settingsRoute,
    ]),
  ]),
  basepath: "/ui",
  defaultPreload: "intent",
  // Query owns caching; the router only triggers loads.
  defaultPreloadStaleTime: 0,
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

function Shell() {
  const bots = useQuery(botsQuery);
  const matchRoute = useMatchRoute();

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <span className="px-2 font-heading font-semibold">Crumble</span>
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
                  {bots.data?.map((bot) => (
                    <SidebarMenuItem key={bot.id}>
                      <SidebarMenuButton
                        isActive={Boolean(
                          matchRoute({
                            to: "/bots/$botId",
                            params: { botId: bot.id },
                            fuzzy: true,
                          }),
                        )}
                        render={
                          <Link to="/bots/$botId" params={{ botId: bot.id }} />
                        }
                      >
                        <Avatar size="sm">
                          <AvatarFallback>
                            {bot.name.slice(0, 1)}
                          </AvatarFallback>
                        </Avatar>
                        <span className={bot.enabled ? "" : "opacity-50"}>
                          {bot.name}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
                {bots.isError && (
                  <p className="px-2 text-xs text-destructive">
                    {bots.error.message}
                  </p>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={Boolean(matchRoute({ to: "/settings" }))}
                  render={<Link to="/settings" />}
                >
                  <SettingsIcon />
                  Settings
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => token.set(null)}>
                  <LogOutIcon />
                  Sign out
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="h-dvh">
          <header className="flex h-12 shrink-0 items-center px-2 md:hidden">
            <SidebarTrigger />
          </header>
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
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
        <EmptyTitle>{empty ? "No bots yet" : "Choose a bot"}</EmptyTitle>
        <EmptyDescription>
          {empty
            ? "Create a bot to start chatting."
            : "Pick a bot from the sidebar to open its chat."}
        </EmptyDescription>
      </EmptyHeader>
      {empty && (
        <EmptyContent>
          <Button render={<Link to="/bots/new" />} nativeButton={false}>
            <PlusIcon data-icon="inline-start" />
            New bot
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
