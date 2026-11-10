import { bearerAuth } from "hono/bearer-auth";
import { Context, Effect } from "effect";
import { contractApp, routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { registerAgentRoutes } from "../bots/agents-api";
import { registerExecutionRoutes } from "../bots/executions-api";
import { registerBotActivityRoutes } from "../bots/bot-activity-api";
import type { AgentRuntime } from "../bots/runtime";
import type { BotsAccess } from "../bots/bots";
import { registerChatRoutes } from "../bots/chat-api";
import { registerDesktopRoutes } from "../bot-desktop/desktop-api";
import { desktopControlAccess } from "../bot-desktop/desktop-control";
import type { ViewerTickets } from "../bot-desktop/desktop-viewer";
import { registerCredentialRoutes } from "../credentials/credentials-api";
import { registerGitHubAppRoutes } from "../github-apps/github-apps-api";
import { registerLoginRoutes } from "../logins/logins-api";
import { registerHeldActionRoutes } from "../bot-desktop/held-actions-api";
import { heldActionsAccess } from "../bot-desktop/held-actions";
import { registerJudgeModelRoutes } from "../bot-desktop/judge-settings";
import { registerVisionModelRoutes } from "../vision/vision-api";
import { registerBotRequestRoutes } from "../bot-requests/bot-requests-api";
import { BotRequests } from "../bot-requests/bot-requests";
import { registerGroupChatRoutes } from "../group-chats/group-chats-api";
import { GroupChats, groupChatsAccess } from "../group-chats/group-chats";
import { registerMcpServerRoutes } from "../integrations/mcp-servers-api";
import { McpServers } from "../integrations/mcp-servers";
import { registerMemoryRoutes } from "../memory/memory-api";
import { registerPasswordManagerRoutes } from "../secrets/password-managers-api";
import { registerPluginSettingRoutes } from "../plugins/plugin-settings-api";
import {
  registerProviderRoutes,
  providerSchema,
} from "../providers/providers-api";
import { ProviderSignIns } from "../providers/provider-auth";
import { Push } from "../push/push";
import { registerPushRoutes } from "../push/push-api";
import { registerScheduleRoutes } from "../automations/schedules-api";
import type { Scheduler } from "../automations/scheduler";
import type { ScriptRuns } from "../automations/script-runs";
import type { CoreServices } from "./core-layer";
import type { OwnerSkills } from "../skills/owner-skills";
import type { Runner } from "../shared/runner";
import { registerActivityRoutes } from "../activity/activity-api";
import { registerLearningRoutes } from "../learning/learning-api";
import {
  registerBotSkillRoutes,
  registerSkillRoutes,
} from "../skills/skills-api";
import { pluginJobKinds, pluginProviders, Plugins } from "../plugins/plugins";
import { BotWorkspaces } from "../workspaces/workspace";
import { registerWebSearchRoutes } from "../web-search/web-search-api";
import { registerGatewayRoutes } from "../message-gateway/gateway-api";
import type { MessageGateway } from "../message-gateway/message-gateway";
import type { EventSources } from "../event-sources/event-sources";
import { registerEventSourceRoutes } from "../event-sources/event-sources-api";
import { registerVoiceGatewayRoutes } from "../voice-gateway/voice-gateway-api";
import type { VoiceGateway } from "../voice-gateway/voice-gateway";
import { registerCallRequestRoutes } from "../voice-gateway/call-requests-api";
import { CallRequests } from "../voice-gateway/call-requests";
import { handleApiError } from "./api-errors";
import { limitBodies, pathRegister } from "./api-requests";

export type ApiServices =
  | CoreServices
  | BotRequests
  | CallRequests
  | BotWorkspaces
  | OwnerSkills
  | EventSources
  | GroupChats
  | McpServers
  | MessageGateway
  | Plugins
  | ProviderSignIns
  | Push
  | Scheduler
  | ScriptRuns
  | VoiceGateway;

export type ApiBots = BotsAccess & {
  core: Runner<ApiServices>;
  runtime: AgentRuntime;
};

type ApiApp = ReturnType<typeof contractApp>;

export type ApiOptions = {
  viewerTickets: ViewerTickets;
};

function apiContext(
  app: ApiApp,
  service: ApiBots,
  options: ApiOptions,
  register: Register,
) {
  const { core, runtime } = service;
  const services = core.runSync(Effect.context<ApiServices>());
  const plugins = Context.get(services, Plugins);
  const providerAuth = Context.get(services, ProviderSignIns);

  return {
    app,
    register,
    service,
    run: core,
    runtime,
    workspaces: Context.get(services, BotWorkspaces),
    plugins,
    jobKinds: pluginJobKinds(plugins).map((kind) => kind.kind),
    groupChats: groupChatsAccess(Context.get(services, GroupChats)),
    externalAuth: new Map(
      pluginProviders(plugins).flatMap(({ provider, externalAuth }) =>
        externalAuth ? [[provider.id, externalAuth] as const] : [],
      ),
    ),
    botRequests: Context.get(services, BotRequests),
    callRequests: Context.get(services, CallRequests),
    provider: providerSchema(providerAuth.models),
    models: providerAuth.models,
    providerAuth,
    desktopControl: desktopControlAccess(core),
    viewerTickets: options.viewerTickets,
    held: heldActionsAccess(core),
    serverId: Context.get(services, Push).serverId,
  };
}

type ApiContext = ReturnType<typeof apiContext>;

const featureRoutes: ReadonlyArray<(api: ApiContext) => void> = [
  (api) =>
    registerDesktopRoutes({
      ...api,
      control: api.desktopControl,
      tickets: api.viewerTickets,
    }),
  (api) =>
    api.register(routes.capabilities, (c) =>
      c.json(
        {
          coding: api.workspaces !== undefined,
          desktop: api.workspaces?.desktop === true,
          jobKinds: api.jobKinds,
        },
        200,
      ),
    ),
  registerPushRoutes,
  registerWebSearchRoutes,
  registerGatewayRoutes,
  registerEventSourceRoutes,
  registerVoiceGatewayRoutes,
  registerJudgeModelRoutes,
  registerVisionModelRoutes,
  registerAgentRoutes,
  registerChatRoutes,
  registerBotActivityRoutes,
  registerGroupChatRoutes,
  registerCredentialRoutes,
  registerGitHubAppRoutes,
  registerLoginRoutes,
  registerHeldActionRoutes,
  registerBotRequestRoutes,
  registerCallRequestRoutes,
  registerMemoryRoutes,
  registerBotSkillRoutes,
  registerLearningRoutes,
  registerSkillRoutes,
  registerScheduleRoutes,
  registerExecutionRoutes,
  registerActivityRoutes,
  registerProviderRoutes,
  registerPasswordManagerRoutes,
  registerPluginSettingRoutes,
  registerMcpServerRoutes,
];

export function createAPI(
  service: ApiBots,
  token: string,
  options: ApiOptions,
) {
  if (token.length < 32)
    throw new Error("Server token must contain at least 32 characters");
  const app = contractApp();

  limitBodies(app);
  app.use("/v1/*", bearerAuth({ token }));
  app.onError(handleApiError);

  const api = apiContext(app, service, options, pathRegister(app));

  for (const routes of featureRoutes) routes(api);

  return app;
}
