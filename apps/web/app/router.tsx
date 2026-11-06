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
import { HttpError, queryClient } from "@/lib/api";
import { botsQuery } from "@/features/bots/api";
import { chatQuery } from "@/features/chat/api";
import { groupChatQuery, groupsQuery } from "@/features/group-chats/api";
import { authClient } from "@/lib/auth-client";
import { ActivityPage } from "@/features/activity/activity";
import { BotForm } from "@/features/bots/bot-form";
import { Chat } from "@/features/bot-chat/chat";
import { CredentialsSettings } from "@/features/credentials/credentials";
import { GITHUB_APP_WEB_PATHS } from "@crumble/server/contract/github-apps";
import { MCP_OAUTH_WEB_PATH } from "@crumble/server/contract/mcp-oauth";
import { CodingPage } from "@/features/settings/coding";
import { GitHubAppCallback } from "@/features/github-apps/github-apps";
import { UsersPage } from "@/features/settings/admin-settings";
import { LoginsSettings } from "@/features/logins/logins";
import { BotDesktop } from "@/features/bot-desktop/desktop";
import { GroupChatView, GroupForm } from "@/features/group-chats/groups";
import {
  IntegrationsPage,
  OAuthCallback,
} from "@/features/integrations/integrations";
import { MemoryPage } from "@/features/memory/memory";
import { ProvidersSettings } from "@/features/providers/providers";
import { GeneralSettings, SettingsLayout } from "@/features/settings/settings";
import { WebSearchPage } from "@/features/web-search/web-search-settings";
import { JudgeModelPage } from "@/features/providers/judge-model-settings";
import { VisionModelPage } from "@/features/providers/vision-model-settings";
import {
  MessageGatewayPage,
  MessageGatewaysPage,
} from "@/features/message-gateways/message-gateways";
import { EventRelayPage } from "@/features/event-sources/event-relay";
import { PasswordManagersPage } from "@/features/password-managers/password-managers";
import { SkillsPage } from "@/features/skills/skills";
import { AutomationsPage } from "@/features/automations/automations";
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

const automationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/automations",
  component: AutomationsPage,
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

const avatarsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/avatars",
  component: AvatarsPage,
});

const oauthRoute = createRoute({
  getParentRoute: () => appRoute,
  path: MCP_OAUTH_WEB_PATH,
  component: OAuthCallback,
});

const githubAppCallbackRoute = createRoute({
  getParentRoute: () => appRoute,
  path: GITHUB_APP_WEB_PATHS.created,
  component: () => <GitHubAppCallback step="created" />,
});

const githubAppInstalledRoute = createRoute({
  getParentRoute: () => appRoute,
  path: GITHUB_APP_WEB_PATHS.installed,
  component: () => <GitHubAppCallback step="installed" />,
});

const githubAppAuthorizedRoute = createRoute({
  getParentRoute: () => appRoute,
  path: GITHUB_APP_WEB_PATHS.authorized,
  component: () => <GitHubAppCallback step="authorized" />,
});

const codingRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/coding",
  component: CodingPage,
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

const usersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/users",
  component: UsersPage,
});

const judgeModelRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/judge-model",
  component: JudgeModelPage,
});

const visionModelRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/vision-model",
  component: VisionModelPage,
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
      newGroupRoute,
      groupRoute,
      editGroupRoute,
      memoryRoute,
      automationsRoute,
      activityRoute,
      soundsRoute,
      avatarsRoute,
      oauthRoute,
      githubAppCallbackRoute,
      githubAppInstalledRoute,
      githubAppAuthorizedRoute,
      settingsRoute.addChildren([
        settingsIndexRoute,
        generalRoute,
        providersRoute,
        passwordManagersRoute,
        webSearchRoute,
        judgeModelRoute,
        visionModelRoute,
        settingsCredentialsRoute,
        settingsLoginsRoute,
        settingsIntegrationsRoute,
        codingRoute,
        usersRoute,
        messageGatewaysRoute,
        messageGatewayRoute,
        eventRelayRoute,
        settingsSkillsRoute,
      ]),
    ]),
  ]),
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
