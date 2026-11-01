import { useQuery } from "@tanstack/react-query";
import {
  Link,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { z } from "zod";
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
import { CredentialsSettings } from "@/features/credentials/credentials";
import { GitHubAppCallback } from "@/features/bots/github-app";
import { LoginsSettings } from "@/features/logins/logins";
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
import { WebSearchPage } from "@/features/settings/web-search-settings";
import { JudgeModelPage } from "@/features/settings/judge-model-settings";
import {
  MessageGatewayPage,
  MessageGatewaysPage,
} from "@/features/settings/message-gateways";
import { EventRelayPage } from "@/features/settings/event-relay";
import { PasswordManagersPage } from "@/features/settings/password-managers";
import { SkillsPage } from "@/features/skills/skills";
import { AutomationsPage } from "@/features/schedules/automations";
import { SoundsPage } from "@/features/sounds/sounds";
import { AvatarsPage } from "@/features/avatars/avatars";

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

// Credentials moved into settings; a bot's old link opens them with the bot picked.
const credentialsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/bots/$botId/credentials",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/settings/credentials",
      search: { bot: params.botId },
      replace: true,
    });
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

const automationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/automations",
  component: AutomationsPage,
});

const tasksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tasks",
  beforeLoad: () => {
    throw redirect({ to: "/automations", replace: true });
  },
});

const activityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/activity",
  component: ActivityPage,
});

// Not linked from the navigation: a place to hear the notification sounds.
const soundsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sounds",
  component: SoundsPage,
});

// Not linked from the navigation: a place to try bot avatars and their gestures.
const avatarsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/avatars",
  component: AvatarsPage,
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

const githubAppCallbackRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/github-app/callback",
  component: GitHubAppCallback,
});

const githubAppInstalledRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/github-app/installed",
  component: GitHubAppCallback,
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

const passwordManagersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/password-managers",
  component: PasswordManagersPage,
});

const webSearchRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/web-search",
  component: WebSearchPage,
});

const judgeModelRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/judge-model",
  component: JudgeModelPage,
});

const settingsCredentialsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/credentials",
  validateSearch: z.object({ bot: z.string().optional() }),
  component: function CredentialsSettingsPage() {
    const { bot } = settingsCredentialsRoute.useSearch();

    return <CredentialsSettings key={bot ?? "all"} initialBot={bot} />;
  },
});

const settingsLoginsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/logins",
  validateSearch: z.object({ bot: z.string().optional() }),
  component: function LoginsSettingsPage() {
    const { bot } = settingsLoginsRoute.useSearch();

    return <LoginsSettings key={bot ?? "all"} initialBot={bot} />;
  },
});

const settingsIntegrationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/integrations",
  component: IntegrationsPage,
});

const messageGatewaysRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/message-gateways",
  component: MessageGatewaysPage,
});

const messageGatewayRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/message-gateways/$gatewayId",
  component: function MessageGatewayRoutePage() {
    const { gatewayId } = messageGatewayRoute.useParams();

    return <MessageGatewayPage key={gatewayId} gatewayId={gatewayId} />;
  },
});

const eventRelayRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/event-relay",
  component: EventRelayPage,
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
      automationsRoute,
      tasksRoute,
      activityRoute,
      soundsRoute,
      avatarsRoute,
      integrationsRoute,
      oauthRoute,
      githubAppCallbackRoute,
      githubAppInstalledRoute,
      settingsRoute.addChildren([
        settingsIndexRoute,
        generalRoute,
        providersRoute,
        passwordManagersRoute,
        webSearchRoute,
        judgeModelRoute,
        settingsCredentialsRoute,
        settingsLoginsRoute,
        settingsIntegrationsRoute,
        messageGatewaysRoute,
        messageGatewayRoute,
        eventRelayRoute,
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
