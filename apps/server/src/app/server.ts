import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { type BunWebSocketData, websocket } from "@hono/bun";
import { createAuth, trustedOriginsFor } from "./auth";
import { accountDir, accountsDir } from "./data-dir";
import { DataDirLocked, lockDataDir } from "./data-lock";
import { adminAPI } from "./admin-api";
import {
  novncResponse,
  VIEWER_PREFIX,
  viewerPathOwner,
} from "../bot-desktop/desktop-viewer";
import { createTenant } from "./tenant";
import { webUIRoutes } from "./web-ui";
import {
  CLIENT_DOCUMENT_PATH,
  clientDocument,
  clientDocumentBody,
  type ClientDocument,
} from "../integrations/mcp-oauth";
import type { Effect, Scope } from "effect";
import type { Workspaces } from "../workspaces/workspace";
import { devWorkspaceEnv } from "./dev-workspaces";
import { MASTER_KEY_VARIABLE } from "../shared/secret-box";
import type { ServerSettings } from "./server-settings";
import { openAPIDocument } from "../contract/api-contract";
import { credentialAccount } from "../shared/account-id";
import {
  VOICE_GATEWAY_PREFIX,
  VOICE_GATEWAY_TOKEN_HEADER,
  voiceGatewayRefusal,
} from "../voice-gateway/voice-gateway-api";

const TENANT_PREFIXES = ["/v1/", `${VIEWER_PREFIX}/`, "/api/auth/"];

const SERVER_PATHS = [
  ...TENANT_PREFIXES.map((prefix) => `${prefix}*`),
  "/health",
  "/openapi.json",
  CLIENT_DOCUMENT_PATH,
];

let openAPI: string | undefined;

function hostedResponse(
  path: string,
  oauthClient: ClientDocument | undefined,
): Response | undefined {
  if (path === "/health") return Response.json({ status: "ok", apiVersion: 1 });

  if (path === "/openapi.json") {
    openAPI ??= JSON.stringify(openAPIDocument());

    return new Response(openAPI, {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (path === CLIENT_DOCUMENT_PATH)
    return oauthClient
      ? Response.json(clientDocumentBody(oauthClient), {
          headers: { "Cache-Control": "public, max-age=3600" },
        })
      : new Response("Not found", { status: 404 });

  return undefined;
}

function untrustedOrigin(
  request: Request,
  requestOrigin: string | null,
  trusted: readonly string[],
) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;

  return !!requestOrigin && !trusted.includes(requestOrigin);
}

function needsOriginForWrite(request: Request, requestOrigin: string | null) {
  return (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    !requestOrigin &&
    request.headers.has("cookie") &&
    !request.headers.has("authorization")
  );
}

const closing = () => new Response("Server is closing", { status: 503 });

type Tenant = Awaited<ReturnType<typeof createTenant>>;

function publicOrigin(publicUrl: string) {
  const url = new URL(publicUrl);

  if (
    url.protocol !== "https:" ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "CRUMBLE_PUBLIC_URL must be an https origin without a path, query, or fragment",
    );

  return url;
}

async function closeTenants(tenants: Iterable<Promise<Tenant>>) {
  const settled = await Promise.allSettled(tenants);

  const results = await Promise.allSettled(
    settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.close()] : [],
    ),
  );

  const failed: unknown[] = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );

  if (failed.length) throw new AggregateError(failed, "Tenant shutdown failed");
}

type ServerOptions = {
  dataDir?: string;
  hostname?: string;
  port?: number;
  publicUrl?: string;
  skillsDir?: string;
  workspaceEnv?: Record<string, string | undefined>;
  workspaces?: (
    userId: string,
  ) => Effect.Effect<Workspaces | undefined, never, Scope.Scope>;
};

function listenSettings(options: ServerOptions) {
  return {
    dataDir: resolve(
      options.dataDir ?? process.env["CRUMBLE_DATA_DIR"] ?? "./data",
    ),
    publicUrl: options.publicUrl ?? process.env["CRUMBLE_PUBLIC_URL"],
    hostname: options.hostname ?? process.env["CRUMBLE_HOST"] ?? "127.0.0.1",
    port: options.port ?? Number(process.env["CRUMBLE_PORT"] ?? 7337),
  };
}

type Accounts = Awaited<ReturnType<typeof createAuth>>;

type ServerState = {
  identity?: Accounts;
  admin?: ReturnType<typeof adminAPI>;
  closed: boolean;
  trustedOrigins: string[];
  ready?: Promise<void>;
};

async function restoreTenants(
  dataDir: string,
  accounts: Accounts,
  tenant: (userId: string) => Promise<Tenant>,
) {
  const usersDir = accountsDir(dataDir);

  if (!existsSync(usersDir)) return;

  for (const entry of readdirSync(usersDir, { withFileTypes: true })) {
    if (entry.isDirectory() && accounts.hasUser(entry.name))
      await tenant(entry.name);
  }
}

const outdatedWorkspaces = async (tenants: Map<string, Promise<Tenant>>) =>
  (
    await Promise.all(
      [...tenants].map(async ([userId, pending]) =>
        ((await pending.catch(() => {}))?.workspaces?.outdated() ?? []).map(
          (agentId) => ({ userId, agentId }),
        ),
      ),
    )
  ).flat();

function tenantPool(pool: {
  dataDir: string;
  oauthClient: ClientDocument | undefined;
  options: ServerOptions;
  serverSettings: () => ServerSettings;
}) {
  const { dataDir, oauthClient, options, serverSettings } = pool;
  const tenants = new Map<string, Promise<Tenant>>();

  const tenant = (userId: string) => {
    const userDir = accountDir(dataDir, userId);
    let pending = tenants.get(userId);

    if (!pending) {
      pending = createTenant({
        dataDir: userDir,
        tenantId: userId,
        skillsDir: options.skillsDir ?? process.env["CRUMBLE_SKILLS_DIR"],
        oauthClient,
        workspaceEnv: options.workspaceEnv ?? process.env,
        workspaces: options.workspaces?.(userId),
        serverSettings,
      });
      tenants.set(userId, pending);
      void pending.catch(() => tenants.delete(userId));
    }

    return pending;
  };

  return {
    tenant,
    removeAccount: async (userId: string) => {
      const pending = tenants.get(userId);

      tenants.delete(userId);
      await pending
        ?.then(async (context) => {
          await context.removeWorkspaces();
          await context.close();
        })
        .catch(() => {});
      rmSync(accountDir(dataDir, userId), { recursive: true, force: true });
    },
    restore: (accounts: Accounts) => restoreTenants(dataDir, accounts, tenant),
    outdatedWorkspaces: () => outdatedWorkspaces(tenants),
    close: () => closeTenants(tenants.values()),
  };
}

type TenantPool = ReturnType<typeof tenantPool>;

// Bun upgrades require the original incoming Request instance.
async function forward(
  pool: TenantPool,
  request: Request,
  bunServer: Bun.Server<unknown>,
  userId: string,
) {
  const context = await pool.tenant(userId);

  request.headers.set("authorization", `Bearer ${context.token}`);

  return context.app.fetch(request, bunServer);
}

async function accountResponse(
  state: ServerState,
  pool: TenantPool,
  request: Request,
  bunServer: Bun.Server<unknown>,
  path: string,
) {
  const session = await state.identity!.auth.api.getSession({
    headers: request.headers,
  });

  // A viewer link is its own credential: a web view cannot send the owner's session, so without one the link
  // goes to the account it names. A session keeps it within the session's account.
  const owner = session ? undefined : viewerPathOwner(path);

  if (owner && state.identity!.hasUser(owner) && !state.closed)
    return forward(pool, request, bunServer, owner);

  if (!session)
    return Response.json({ error: "Sign in required" }, { status: 401 });

  if (state.closed) return closing();
  const response = await forward(pool, request, bunServer, session.user.id);

  if (response) response.headers.set("Cache-Control", "no-store");

  return response;
}

type VoiceGatewayHost = {
  closed: boolean;
  hasUser: (userId: string) => boolean;
  forward: (userId: string) => Promise<Response | undefined>;
};

const BEARER = /^Bearer\s+(\S+)$/iu;

/**
 * A voice gateway token names its account, as a viewer ticket does; the account checks the secret. No session is
 * read here, so a session never reaches these routes. An unknown account gets the same status, body, and headers
 * as a wrong secret, though not the same timing.
 */
export async function voiceGatewayResponse(
  request: Request,
  host: VoiceGatewayHost,
) {
  if (host.closed) {
    const response = closing();

    response.headers.set("Cache-Control", "no-store");

    return response;
  }

  const token = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
  const account = token && credentialAccount(token);

  if (!token || !account || !host.hasUser(account))
    return voiceGatewayRefusal();

  request.headers.set(VOICE_GATEWAY_TOKEN_HEADER, token);
  const response = await host.forward(account);

  if (response) response.headers.set("Cache-Control", "no-store");

  return response;
}

async function adminResponse(state: ServerState, request: Request) {
  if (state.closed) return closing();
  const response = await state.admin!.fetch(request);

  response.headers.set("Cache-Control", "no-store");

  return response;
}

function apiResponse(
  state: ServerState,
  pool: TenantPool,
  request: Request,
  bunServer: Bun.Server<unknown>,
  path: string,
) {
  if (path.startsWith(VOICE_GATEWAY_PREFIX))
    return voiceGatewayResponse(request, {
      closed: state.closed,
      hasUser: (userId) => state.identity!.hasUser(userId),
      forward: (userId) => forward(pool, request, bunServer, userId),
    });

  if (path.startsWith("/v1/admin/")) return adminResponse(state, request);

  return accountResponse(state, pool, request, bunServer, path);
}

const requestHandler =
  (
    state: ServerState,
    pool: TenantPool,
    oauthClient: ClientDocument | undefined,
  ) =>
  async (request: Request, bunServer: Bun.Server<BunWebSocketData>) => {
    await state.ready;
    request.headers.delete(VOICE_GATEWAY_TOKEN_HEADER);
    const path = new URL(request.url).pathname;
    const hosted = hostedResponse(path, oauthClient);

    if (hosted) return hosted;

    if (!TENANT_PREFIXES.some((prefix) => path.startsWith(prefix)))
      return new Response("Not found", { status: 404 });
    const requestOrigin = request.headers.get("origin");

    if (untrustedOrigin(request, requestOrigin, state.trustedOrigins))
      return Response.json({ error: "Untrusted origin" }, { status: 403 });

    // Admins act through /v1/admin/; the plugin's own routes would also let them impersonate users.
    if (path.startsWith("/api/auth/admin/"))
      return new Response("Not found", { status: 404 });

    if (path.startsWith("/api/auth/"))
      return state.identity!.auth.handler(request);

    const novnc = await novncResponse(path);

    if (novnc) return novnc;

    if (needsOriginForWrite(request, requestOrigin))
      return Response.json(
        { error: "Origin is required for cookie-authenticated writes" },
        { status: 403 },
      );

    return apiResponse(state, pool, request, bunServer, path);
  };

const serve = (
  handle: ReturnType<typeof requestHandler>,
  hostname: string,
  port: number,
) =>
  Bun.serve({
    // The UI answers every other path, so the server's own paths are routes too, ahead of its wildcard.
    routes: {
      ...webUIRoutes,
      ...Object.fromEntries(SERVER_PATHS.map((path) => [path, handle])),
    },
    development: process.env.NODE_ENV !== "production" && { hmr: false },
    websocket,
    hostname,
    port,
    idleTimeout: 60,
    fetch: handle,
  });

async function connectAccounts(
  state: ServerState,
  pool: TenantPool,
  dataDir: string,
  origin: string,
) {
  state.identity = await createAuth(dataDir, origin);
  state.admin = adminAPI({
    accounts: state.identity,
    origin: () => origin,
    removeAccount: pool.removeAccount,
    outdatedWorkspaces: pool.outdatedWorkspaces,
  });
  await pool.restore(state.identity);
}

export async function startServer(options: ServerOptions = {}) {
  const { dataDir, publicUrl, hostname, port } = listenSettings(options);

  const oauthClient = publicUrl
    ? clientDocument(publicOrigin(publicUrl))
    : undefined;

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  const release = await lockDataDir(dataDir);
  const state: ServerState = { closed: false, trustedOrigins: [] };

  const pool = tenantPool({
    dataDir,
    oauthClient,
    options,
    serverSettings: () => state.identity!.settings.get(),
  });

  let server: ReturnType<typeof Bun.serve> | undefined;

  const close = async () => {
    if (state.closed) return;
    state.closed = true;

    try {
      await server?.stop(true);
      await pool.close();
    } finally {
      state.identity?.close();
      await release();
    }
  };

  try {
    server = serve(requestHandler(state, pool, oauthClient), hostname, port);

    const origin = new URL(
      publicUrl ?? process.env["BETTER_AUTH_URL"] ?? server.url.origin,
    ).origin;

    state.trustedOrigins = trustedOriginsFor(origin);
    state.ready = connectAccounts(state, pool, dataDir, origin);
    await state.ready;

    return { server, auth: state.identity!.auth, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function exitIfLocked(error: Error): never {
  if (error instanceof DataDirLocked) {
    console.error(error.message);
    process.exit(1);
  }

  throw error;
}

if (import.meta.main) {
  const running = await startServer(
    process.argv.includes("--dev-workspaces")
      ? { workspaceEnv: devWorkspaceEnv(process.env) }
      : {},
  ).catch(exitIfLocked);

  console.log(`Crumble server listening on ${running.server.url}`);
  console.log("Open it to create an account or sign in.");

  if (!process.env[MASTER_KEY_VARIABLE])
    console.log(
      `${MASTER_KEY_VARIABLE} is unset: account encryption keys are stored next to the data they protect.`,
    );

  const close = async () => {
    await running.close();
    process.exit(0);
  };

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
