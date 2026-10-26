import { useQuery } from "@tanstack/react-query";
import {
  Link,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Connect } from "./connect";
import { Home } from "./home";
import { Shell } from "./shell";
import {
  HttpError,
  botsQuery,
  chatQuery,
  groupChatQuery,
  groupsQuery,
  queryClient,
} from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { ActivityPage } from "@/features/activity/activity";
import { BotForm } from "@/features/bots/bot-form";
import { Chat } from "@/features/chat/chat";
import { CredentialsPage } from "@/features/credentials/credentials";
import { BotDesktop } from "@/features/bot-desktop/desktop";
import { GroupChatView, GroupForm } from "@/features/group-chats/groups";
import {
  IntegrationsPage,
  OAuthCallback,
} from "@/features/integrations/integrations";
import { MemoryPage } from "@/features/memory/memory";
import {
  GeneralSettings,
  ProvidersSettings,
  SettingsLayout,
} from "@/features/settings/settings";
import { SkillsPage } from "@/features/skills/skills";
import { TasksPage } from "@/features/schedules/tasks";

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
  loader: ({ params }) =>
    queryClient.query({ ...chatQuery(params.botId), staleTime: "static" }),
  component: function BotPage() {
    const { botId } = botRoute.useParams();

    return <Chat key={botId} botId={botId} />;
  },
});

const editBotRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/bots/$botId/edit",
  loader: () => queryClient.query({ ...botsQuery, staleTime: "static" }),
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
    queryClient.query({
      ...groupChatQuery(params.groupId),
      staleTime: "static",
    }),
  component: function GroupPage() {
    const { groupId } = groupRoute.useParams();

    return <GroupChatView key={groupId} groupId={groupId} />;
  },
});

const editGroupRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/groups/$groupId/edit",
  loader: () => queryClient.query({ ...groupsQuery, staleTime: "static" }),
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

export const router = createRouter({
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
