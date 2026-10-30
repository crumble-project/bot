import type { ErrorHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { Effect } from "effect";
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
import { loginsAccess } from "../logins/logins";
import { registerBotRequestRoutes } from "../bot-requests/bot-requests-api";
import type { BotRequests } from "../bot-requests/bot-requests";
import {
  credentialsAccess,
  type CredentialsAccess,
} from "../credentials/credentials";
import { registerGroupChatRoutes } from "../group-chats/group-chats-api";
import type { GroupChatsAccess } from "../group-chats/group-chats";
import { registerMcpServerRoutes } from "../integrations/mcp-servers-api";
import type { McpIntegrations } from "../integrations/integrations";
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
  standaloneSignIns,
  type ProviderSignInsAccess,
} from "../providers/provider-auth";
import { Push, type PushRuntime } from "../push/push";
import { registerPushRoutes } from "../push/push-api";
import { registerScheduleRoutes } from "../schedules/schedules-api";
import type { SchedulerAccess } from "../schedules/scheduler";
import type { ScriptRuns } from "../schedules/script-runs";
import { MAX_MESSAGE_BODY } from "../shared/attachments";
import type { CoreServices } from "./core-layer";
import type { CommonSkill } from "../skills/common-skills";
import { httpStatus, isAppError } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { registerActivityRoutes } from "../activity/activity-api";
import { registerSkillRoutes } from "../skills/skills-api";
import type { DesktopStream } from "../workspaces/workspace";
import type { DesktopOpenError } from "../workspaces/workspace-errors";
import type { ExternalAuth } from "../plugins/plugins";
import { registerWebSearchRoutes } from "../web-search/settings";

/** The bots the API serves, with the account's repositories and bot runtime its handlers read directly. */
export type ApiBots = BotsAccess & {
  core: Runner<CoreServices>;
  runtime: AgentRuntime;
};

type ApiApp = ReturnType<typeof contractApp>;

/** Everything the API can be built with beyond the bots, the scheduler, and the token. */
export type ApiOptions = {
  commonSkills?: CommonSkill[];
  /** Whether the server can give bots the coding tool. */
  coding?: boolean;
  /** Script run history; its route answers 503 without it. */
  scriptRuns?: ScriptRuns["Service"];
  /** Whether the server can give bots the desktop tool. */
  desktop?: boolean;
  /** Stops a bot's workspace machine, so its next use boots the image its tools need now. */
  restartWorkspace?: (agentId: string) => Promise<void>;
  /** Group chats; their routes answer 503 without it. */
  groupChats?: GroupChatsAccess;
  /** Who operates each bot desktop. */
  desktopControl?: DesktopControlAccess;
  /** Single-use viewer links. */
  viewerTickets?: ViewerTickets;
  /** Connects to a bot desktop's VNC server, for viewers; a passive one only watches a running machine. */
  openDesktop?: (
    agentId: string,
    options: { passive: boolean },
  ) => Effect.Effect<DesktopStream, DesktopOpenError>;
  /** Whether a bot's machine runs its bot desktop now. */
  desktopRunning?: (agentId: string) => boolean;
  /** Boots a bot's machine ahead of a viewer's connection. */
  startDesktop?: (agentId: string) => Effect.Effect<void, DesktopOpenError>;
  /** The server's provider sign-ins; API-only fixtures get one of their own. */
  providerAuth?: ProviderSignInsAccess;
  /** The server's OAuth client metadata document, when it has a public address. */
  oauthClient?: ClientDocument | undefined;
  /** Providers whose sign-in happens outside Crumble, by provider ID. */
  externalAuth?: ReadonlyMap<string, () => Promise<ExternalAuth>>;
  /** The bots' credentials; API-only fixtures get their own. */
  credentials?: CredentialsAccess;
  botRequests?: BotRequests["Service"];
};

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

/** The bot desktop routes get the server's own control state and viewer tickets unless a test supplies them. */
const desktopRouteOptions = (
  options: ApiOptions,
  app: ApiApp,
  register: Register,
  service: ApiBots,
  run: Runner<CoreServices>,
) => ({
  app,
  register,
  service,
  run,
  desktop: options.desktop === true,
  control: options.desktopControl ?? desktopControlAccess(run),
  tickets: options.viewerTickets ?? new ViewerTickets(),
  ...(options.openDesktop && { openDesktop: options.openDesktop }),
  ...(options.startDesktop && { startDesktop: options.startDesktop }),
  ...(options.desktopRunning && { desktopRunning: options.desktopRunning }),
});

const pushServerIdOf = (push: PushRuntime | undefined) =>
  push?.runSync(Push.use((service) => Effect.succeed(service.serverId)));

/** What the server offers the bots' tools, as the clients probe it. */
const capabilitiesOf = (options: ApiOptions) => ({
  coding: options.coding === true,
  desktop: options.desktop === true,
});

export function createAPI(
  service: ApiBots,
  scheduler: SchedulerAccess,
  token: string,
  integrations?: McpIntegrations["Service"],
  options: ApiOptions = {},
  push?: PushRuntime,
) {
  if (token.length < 32)
    throw new Error("Server token must contain at least 32 characters");
  const { core, runtime } = service;
  const app = contractApp();

  const credentials = options.credentials ?? credentialsAccess(core);
  const secrets = secretStorage(core);
  const providerAuth = options.providerAuth ?? standaloneSignIns(core);
  const provider = providerSchema(providerAuth.models);
  const register = pathRegister(app);

  setupPipeline({ app, register, token, oauthClient: options.oauthClient });
  registerDesktopRoutes(
    desktopRouteOptions(options, app, register, service, core),
  );

  register(routes.capabilities, (c) => c.json(capabilitiesOf(options), 200));
  registerPushRoutes(register, push);
  registerWebSearchRoutes(register, core);

  const pushServerId = pushServerIdOf(push);

  const api = {
    ...options,
    register,
    service,
    run: core,
    scheduler,
    runtime,
    credentials,
    secrets,
    provider,
    providerAuth,
    integrations,
    pushServerId,
  };

  registerAgentRoutes(api);
  registerChatRoutes(api);
  registerBotActivityRoutes(api);
  registerGroupChatRoutes(api);
  registerCredentialRoutes(api);
  registerLoginRoutes({ ...api, logins: loginsAccess(core) });

  if (options.botRequests)
    registerBotRequestRoutes({ ...api, botRequests: options.botRequests });
  registerMemoryRoutes(api);
  registerSkillRoutes(api);
  registerScheduleRoutes(api);
  registerActivityRoutes(api);
  registerProviderRoutes(api);
  registerPasswordManagerRoutes(api);
  registerMcpServerRoutes(api);

  return app;
}
