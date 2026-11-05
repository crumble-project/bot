import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";
import type { RouteConfig } from "@hono/zod-openapi";
import { z } from "zod";
import { Context, Effect } from "effect";
import { contractApp, routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { registerAgentRoutes } from "../bots/agents-api";
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
import { registerVisionModelRoutes } from "../vision/vision-settings";
import { loginsAccess } from "../logins/logins";
import { registerBotRequestRoutes } from "../bot-requests/bot-requests-api";
import { BotRequests } from "../bot-requests/bot-requests";
import { credentialsAccess } from "../credentials/credentials";
import { registerGroupChatRoutes } from "../group-chats/group-chats-api";
import { GroupChats, groupChatsAccess } from "../group-chats/group-chats";
import { registerMcpServerRoutes } from "../integrations/mcp-servers-api";
import { McpIntegrations } from "../integrations/integrations";
import type { ClientDocument } from "../integrations/mcp-oauth";
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
import { Scheduler, schedulerAccess } from "../automations/scheduler";
import { ScriptRuns } from "../automations/script-runs";
import { MAX_MESSAGE_BODY } from "../shared/attachment-rules";
import type { CoreServices } from "./core-layer";
import { CommonSkills } from "../skills/common-skills";
import type { Runner } from "../shared/runner";
import { registerActivityRoutes } from "../activity/activity-api";
import { registerSkillRoutes } from "../skills/skills-api";
import { pluginJobKinds, pluginProviders, Plugins } from "../plugins/plugins";
import { BotWorkspaces } from "../workspaces/workspace";
import { registerWebSearchRoutes } from "../web-search/settings";
import { registerGatewayRoutes } from "../message-gateway/gateway-api";
import { MessageGateway } from "../message-gateway/message-gateway";
import { EventSources } from "../event-sources/event-sources";
import { registerEventSourceRoutes } from "../event-sources/event-sources-api";
import { handleApiError } from "./api-errors";

/** Every account service the routes read. */
export type ApiServices =
  | CoreServices
  | BotRequests
  | BotWorkspaces
  | CommonSkills
  | EventSources
  | GroupChats
  | McpIntegrations
  | MessageGateway
  | Plugins
  | ProviderSignIns
  | Push
  | Scheduler
  | ScriptRuns;

/** The bots the API serves, with the account's services and bot runtime its handlers read directly. */
export type ApiBots = BotsAccess & {
  core: Runner<ApiServices>;
  runtime: AgentRuntime;
};

type ApiApp = ReturnType<typeof contractApp>;

/** What the routes are built from besides the account's services. */
export type ApiOptions = {
  /** Single-use viewer links. */
  viewerTickets: ViewerTickets;
  /** The server's OAuth client metadata document, when it has a public address. */
  oauthClient: ClientDocument | undefined;
};

/** A route's JSON body schema; a body the contract leaves optional is the handler's to read. */
const requiredBody = (definition: RouteConfig) => {
  const body = definition.request?.body;
  const media = body?.required ? body.content["application/json"] : undefined;
  const schema = media && "schema" in media ? media.schema : undefined;

  return schema instanceof z.ZodType ? schema : undefined;
};

type RequestObject = z.ZodType<object> | undefined;

/** Parses what the route's contract declares, for `c.req.valid`. A `ZodError` becomes the 400 in `handleApiError`. */
const validated = (
  definition: RouteConfig,
  body: z.ZodType | undefined,
): MiddlewareHandler => {
  // SAFETY: a contract's params, query, and JSON bodies are all objects.
  const { params, query, json } = {
    params: definition.request?.params as RequestObject,
    query: definition.request?.query as RequestObject,
    json: body as RequestObject,
  };

  return async (c, next) => {
    if (params) c.req.addValidatedData("param", params.parse(c.req.param()));

    if (query) c.req.addValidatedData("query", query.parse(c.req.query()));

    if (json) c.req.addValidatedData("json", json.parse(await c.req.json()));

    await next();
  };
};

/** Registers a route behind its contract's request schemas. */
export const pathRegister =
  (app: ApiApp): Register =>
  (definition, handler, options) => {
    const body = options?.parsesBody ? undefined : requiredBody(definition);

    app.openAPIRegistry.registerPath(definition);
    app.on(
      definition.method,
      definition.getRoutingPath(),
      validated(definition, body),
      handler,
    );
  };

const messagePaths = [routes.sendMessage, routes.sendGroupMessage].map(
  (route) =>
    new RegExp(`^${route.getRoutingPath().replace(/:[^/]+/g, "[^/]+")}$`),
);

/** Messages may carry attachments; every other request stays small. */
const limitBodies = (app: ApiApp) => {
  const messageBodyLimit = bodyLimit({ maxSize: MAX_MESSAGE_BODY });
  const defaultBodyLimit = bodyLimit({ maxSize: 1024 * 1024 });

  app.use("*", (c, next) =>
    c.req.method === "POST" &&
    messagePaths.some((path) => path.test(c.req.path))
      ? messageBodyLimit(c, next)
      : defaultBodyLimit(c, next),
  );
};

/** Every value the feature routes are built from; each feature's register function takes the part it needs. */
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
    scheduler: schedulerAccess(core),
    scriptRuns: Context.get(services, ScriptRuns),
    workspaces: Context.get(services, BotWorkspaces),
    commonSkills: Context.get(services, CommonSkills),
    plugins,
    jobKinds: pluginJobKinds(plugins).map((kind) => kind.kind),
    groupChats: groupChatsAccess(Context.get(services, GroupChats)),
    externalAuth: new Map(
      pluginProviders(plugins).flatMap(({ provider, externalAuth }) =>
        externalAuth ? [[provider.id, externalAuth] as const] : [],
      ),
    ),
    botRequests: Context.get(services, BotRequests),
    messageGateway: Context.get(services, MessageGateway),
    eventSources: Context.get(services, EventSources),
    credentials: credentialsAccess(core),
    mcpServers: new McpServers({
      run: core,
      integrations: Context.get(services, McpIntegrations),
      oauthClient: options.oauthClient,
    }),
    provider: providerSchema(providerAuth.models),
    models: providerAuth.models,
    providerAuth,
    desktopControl: desktopControlAccess(core),
    viewerTickets: options.viewerTickets,
    logins: loginsAccess(core),
    held: heldActionsAccess(core),
    serverId: Context.get(services, Push).serverId,
  };
}

type ApiContext = ReturnType<typeof apiContext>;

/** Every feature's routes, registered in this order. A new feature adds its register function here. */
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
  registerMemoryRoutes,
  registerSkillRoutes,
  registerScheduleRoutes,
  registerActivityRoutes,
  registerProviderRoutes,
  registerPasswordManagerRoutes,
  registerPluginSettingRoutes,
  registerMcpServerRoutes,
];

/** The account's API, built from the account's services in `service.core`. */
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
