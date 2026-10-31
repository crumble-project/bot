import type { ErrorHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { Context, Effect, Option } from "effect";
import { contractApp, routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { registerAgentRoutes } from "../bots/agents-api";
import { registerBotActivityRoutes } from "../bots/bot-activity-api";
import type { AgentRuntime } from "../bots/runtime";
import type { BotsAccess } from "../bots/bots";
import { registerChatRoutes } from "../bots/chat-api";
import { registerDesktopRoutes } from "../bot-desktop/desktop-api";
import {
  desktopControlAccess,
  type DesktopControlAccess,
} from "../bot-desktop/desktop-control";
import { ViewerTickets } from "../bot-desktop/desktop-viewer";
import { registerCredentialRoutes } from "../credentials/credentials-api";
import { registerLoginRoutes } from "../logins/logins-api";
import { registerHeldActionRoutes } from "../bot-desktop/held-actions-api";
import { heldActionsAccess } from "../bot-desktop/held-actions";
import { registerJudgeModelRoutes } from "../bot-desktop/judge-settings";
import { loginsAccess } from "../logins/logins";
import { registerBotRequestRoutes } from "../bot-requests/bot-requests-api";
import { BotRequests } from "../bot-requests/bot-requests";
import {
  credentialsAccess,
  type CredentialsAccess,
} from "../credentials/credentials";
import { registerGroupChatRoutes } from "../group-chats/group-chats-api";
import {
  GroupChats,
  groupChatsAccess,
  type GroupChatsAccess,
} from "../group-chats/group-chats";
import { registerMcpServerRoutes } from "../integrations/mcp-servers-api";
import { McpIntegrations } from "../integrations/integrations";
import {
  CLIENT_DOCUMENT_PATH,
  clientDocumentBody,
  secretStorage,
  type ClientDocument,
} from "../integrations/mcp-oauth";
import { registerMemoryRoutes } from "../memory/memory-api";
import { registerPasswordManagerRoutes } from "../password-managers/password-managers-api";
import {
  registerProviderRoutes,
  providerSchema,
} from "../providers/providers-api";
import {
  ProviderSignIns,
  providerSignInsAccess,
  standaloneSignIns,
  type ProviderSignInsAccess,
} from "../providers/provider-auth";
import { Push, type PushRuntime } from "../push/push";
import { registerPushRoutes } from "../push/push-api";
import { registerScheduleRoutes } from "../schedules/schedules-api";
import {
  Scheduler,
  schedulerAccess,
  type SchedulerAccess,
} from "../schedules/scheduler";
import { ScriptRuns } from "../schedules/script-runs";
import { MAX_MESSAGE_BODY } from "../shared/attachments";
import type { CoreServices } from "./core-layer";
import { CommonSkills, type CommonSkill } from "../skills/common-skills";
import { httpStatus, isAppError } from "../shared/errors";
import { runnerOf, type Runner } from "../shared/runner";
import { registerActivityRoutes } from "../activity/activity-api";
import { registerSkillRoutes } from "../skills/skills-api";
import type { DesktopStream } from "../workspaces/workspace";
import type { DesktopOpenError } from "../workspaces/workspace-errors";
import {
  pluginJobKinds,
  pluginProviders,
  Plugins,
  type ExternalAuth,
} from "../plugins/plugins";
import { BotWorkspaces } from "../workspaces/workspace";
import { registerWebSearchRoutes } from "../web-search/settings";

/** The bots the API serves, with the account's repositories and bot runtime its handlers read directly. */
export type ApiBots = BotsAccess & {
  core: Runner<CoreServices>;
  runtime: AgentRuntime;
};

type ApiApp = ReturnType<typeof contractApp>;

/**
 * What the routes are built from besides the bots. `createAPI` reads each from the account's services in `core`; a
 * value given here replaces it, as tests do. A missing optional service makes its routes answer 503.
 */
export type ApiOptions = {
  scheduler?: SchedulerAccess | undefined;
  integrations?: McpIntegrations["Service"] | undefined;
  push?: PushRuntime | undefined;
  commonSkills?: CommonSkill[] | undefined;
  /** Whether the server can give bots the coding tool. */
  coding?: boolean | undefined;
  /** Script run history; its route answers 503 without it. */
  scriptRuns?: ScriptRuns["Service"] | undefined;
  /** Whether the server can give bots the desktop tool. */
  desktop?: boolean | undefined;
  /** The job kinds the server's plugins offer bots. */
  jobKinds?: string[] | undefined;
  /** Stops a bot's workspace machine, so its next use boots the image its tools need now. */
  restartWorkspace?: ((agentId: string) => Promise<void>) | undefined;
  /** Group chats; their routes answer 503 without it. */
  groupChats?: GroupChatsAccess | undefined;
  /** Who operates each bot desktop. */
  desktopControl?: DesktopControlAccess | undefined;
  /** Single-use viewer links. */
  viewerTickets?: ViewerTickets | undefined;
  /** Connects to a bot desktop's VNC server, for viewers; a passive one only watches a running machine. */
  openDesktop?:
    | ((
        agentId: string,
        options: { passive: boolean },
      ) => Effect.Effect<DesktopStream, DesktopOpenError>)
    | undefined;
  /** Whether a bot's machine runs its bot desktop now. */
  desktopRunning?: ((agentId: string) => boolean) | undefined;
  /** Boots a bot's machine ahead of a viewer's connection. */
  startDesktop?:
    | ((agentId: string) => Effect.Effect<void, DesktopOpenError>)
    | undefined;
  /** The server's provider sign-ins; API-only fixtures get one of their own. */
  providerAuth?: ProviderSignInsAccess | undefined;
  /** The server's OAuth client metadata document, when it has a public address. */
  oauthClient?: ClientDocument | undefined;
  /** Providers whose sign-in happens outside Crumble, by provider ID. */
  externalAuth?: ReadonlyMap<string, () => Promise<ExternalAuth>> | undefined;
  /** The bots' credentials; API-only fixtures get their own. */
  credentials?: CredentialsAccess | undefined;
  botRequests?: BotRequests["Service"] | undefined;
};

/** A service of the account, or undefined when the runner's context lacks it, as in API-only fixtures. */
const serviceIn =
  (core: Runner<CoreServices>) =>
  <I, S>(key: Context.Key<I, S>) =>
    Option.getOrUndefined(core.runSync(Effect.serviceOption(key)));

/** The options the account's own services provide; a runner over only the repositories provides none of them. */
function accountOptions(core: Runner<CoreServices>): ApiOptions {
  const service = serviceIn(core);
  const workspaces = service(BotWorkspaces);
  const plugins = service(Plugins) ?? [];
  const scheduler = service(Scheduler);
  const push = service(Push);
  const signIns = service(ProviderSignIns);
  const groupChats = service(GroupChats);

  return {
    scheduler:
      scheduler &&
      schedulerAccess(runnerOf(Context.make(Scheduler, scheduler))),
    integrations: service(McpIntegrations),
    push: push && runnerOf(Context.make(Push, push)),
    commonSkills: service(CommonSkills),
    coding: workspaces !== undefined,
    scriptRuns: service(ScriptRuns),
    desktop: workspaces?.desktop === true,
    jobKinds: pluginJobKinds(plugins).map((kind) => kind.kind),
    restartWorkspace:
      workspaces &&
      (async (agentId) => Effect.runPromise(workspaces.restart(agentId))),
    groupChats: groupChats && groupChatsAccess(groupChats),
    openDesktop:
      workspaces &&
      ((agentId, options) => workspaces.openDesktop(agentId, options)),
    desktopRunning:
      workspaces && ((agentId) => workspaces.desktopRunning(agentId)),
    startDesktop: workspaces && ((agentId) => workspaces.startDesktop(agentId)),
    providerAuth:
      signIns &&
      providerSignInsAccess(runnerOf(Context.make(ProviderSignIns, signIns))),
    externalAuth: new Map(
      pluginProviders(plugins).flatMap(({ provider, externalAuth }) =>
        externalAuth ? [[provider.id, externalAuth] as const] : [],
      ),
    ),
    botRequests: service(BotRequests),
  };
}

/** The register function that keeps merge-before-validation PATCH semantics and the existing JSON error handling. */
const pathRegister =
  (app: ApiApp): Register =>
  (definition, handler) => {
    app.openAPIRegistry.registerPath(definition);
    app.on(definition.method, definition.getRoutingPath(), handler);
  };

/** Messages may carry attachments; every other request stays small. */
const limitBodies = (app: ApiApp) => {
  const messageBodyLimit = bodyLimit({ maxSize: MAX_MESSAGE_BODY });
  const defaultBodyLimit = bodyLimit({ maxSize: 1024 * 1024 });

  app.use("*", (c, next) =>
    c.req.method === "POST" &&
    /^\/v1\/(agents|group-chats)\/[^/]+\/messages$/.test(c.req.path)
      ? messageBodyLimit(c, next)
      : defaultBodyLimit(c, next),
  );
};

/** Every error leaves as JSON with the status its type maps to, until the last resort. */
export const handleApiError: ErrorHandler = (error, c) => {
  if (error instanceof HTTPException) return error.getResponse();

  if (error instanceof z.ZodError)
    return c.json({ error: "Invalid request", details: error.issues }, 400);

  if (isAppError(error))
    return c.json({ error: error.message }, httpStatus(error));

  if (error instanceof SyntaxError)
    return c.json({ error: "Invalid JSON" }, 400);
  console.error(error);

  return c.json({ error: "The server could not complete this request" }, 500);
};

/**
 * The pipeline every request passes: body limits, the routes that answer without a token, then the bearer gate
 * and the error handler.
 */
const setupPipeline = (options: {
  app: ApiApp;
  register: Register;
  token: string;
  oauthClient: ClientDocument | undefined;
}) => {
  const { app, register } = options;

  limitBodies(app);
  register(routes.health, (c) =>
    c.json({ status: "ok", apiVersion: 1 } as const, 200),
  );
  // Public like /health: authorization servers fetch it to identify Crumble as an OAuth client.
  app.get(CLIENT_DOCUMENT_PATH, (c) =>
    options.oauthClient
      ? c.json(clientDocumentBody(options.oauthClient), 200, {
          "Cache-Control": "public, max-age=3600",
        })
      : c.notFound(),
  );
  app.use("/v1/*", bearerAuth({ token: options.token }));
  app.onError(handleApiError);
};

/** What the server offers the bots' tools, as the clients probe it. */
const capabilitiesOf = (options: ApiOptions) => ({
  coding: options.coding === true,
  desktop: options.desktop === true,
  jobKinds: options.jobKinds ?? [],
});

/** Every value the feature routes are built from; each feature's register function takes the part it needs. */
function apiContext(
  app: ApiApp,
  service: ApiBots,
  options: ApiOptions,
  register: Register,
) {
  const { core, runtime } = service;
  const providerAuth = options.providerAuth ?? standaloneSignIns(core);
  const desktopControl = options.desktopControl ?? desktopControlAccess(core);

  if (!options.scheduler)
    throw new Error(
      "The API needs a scheduler: none in the account or options",
    );

  return {
    ...options,
    app,
    register,
    service,
    run: core,
    scheduler: options.scheduler,
    runtime,
    credentials: options.credentials ?? credentialsAccess(core),
    secrets: secretStorage(core),
    provider: providerSchema(providerAuth.models),
    providerAuth,
    desktopControl,
    viewerTickets: options.viewerTickets ?? new ViewerTickets(),
    logins: loginsAccess(core),
    held: heldActionsAccess(core),
    pushServerId: options.push?.runSync(
      Push.use((push) => Effect.succeed(push.serverId)),
    ),
  };
}

type ApiContext = ReturnType<typeof apiContext>;

/** Every feature's routes, registered in this order. A new feature adds its register function here. */
const featureRoutes: ReadonlyArray<(api: ApiContext) => void> = [
  (api) =>
    registerDesktopRoutes({
      ...api,
      desktop: api.desktop === true,
      control: api.desktopControl,
      tickets: api.viewerTickets,
    }),
  (api) =>
    api.register(routes.capabilities, (c) => c.json(capabilitiesOf(api), 200)),
  registerPushRoutes,
  registerWebSearchRoutes,
  registerJudgeModelRoutes,
  registerAgentRoutes,
  registerChatRoutes,
  registerBotActivityRoutes,
  registerGroupChatRoutes,
  registerCredentialRoutes,
  registerLoginRoutes,
  registerHeldActionRoutes,
  registerBotRequestRoutes,
  registerMemoryRoutes,
  registerSkillRoutes,
  registerScheduleRoutes,
  registerActivityRoutes,
  registerProviderRoutes,
  registerPasswordManagerRoutes,
  registerMcpServerRoutes,
];

/** The account's API. Everything not in `options` comes from the account's services in `service.core`. */
export function createAPI(
  service: ApiBots,
  token: string,
  options: ApiOptions = {},
) {
  if (token.length < 32)
    throw new Error("Server token must contain at least 32 characters");
  const app = contractApp();
  const register = pathRegister(app);

  const api = apiContext(
    app,
    service,
    { ...accountOptions(service.core), ...options },
    register,
  );

  setupPipeline({ app, register, token, oauthClient: options.oauthClient });

  for (const routes of featureRoutes) routes(api);

  return app;
}
