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

const TENANT_PREFIXES = ["/v1/", `${VIEWER_PREFIX}/`, "/api/auth/"];

const SERVER_PATHS = [
  ...TENANT_PREFIXES.map((prefix) => `${prefix}*`),
  "/health",
  CLIENT_DOCUMENT_PATH,
];

function hostedResponse(
  path: string,
  oauthClient: ClientDocument | undefined,
): Response | undefined {
  if (path === "/health") return Response.json({ status: "ok", apiVersion: 1 });

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

  const failed = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
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

export async function startServer(options: ServerOptions = {}) {
  const { dataDir, publicUrl, hostname, port } = listenSettings(options);

  const oauthClient = publicUrl
    ? clientDocument(publicOrigin(publicUrl))
    : undefined;

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  const release = await lockDataDir(dataDir);

  const tenants = new Map<string, Promise<Tenant>>();

  let identity: Awaited<ReturnType<typeof createAuth>> | undefined;
  let admin: ReturnType<typeof adminAPI> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let closed = false;
  let origin = "";
  let trustedOrigins: string[] = [];
  let ready: Promise<void>;

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
        serverSettings: () => identity!.settings.get(),
      });
      tenants.set(userId, pending);
      void pending.catch(() => tenants.delete(userId));
    }

    return pending;
  };

  const removeAccount = async (userId: string) => {
    const pending = tenants.get(userId);

    tenants.delete(userId);
    await pending
      ?.then(async (context) => {
        await context.removeWorkspaces();
        await context.close();
      })
      .catch(() => undefined);
    rmSync(accountDir(dataDir, userId), { recursive: true, force: true });
  };

  const close = async () => {
    if (closed) return;
    closed = true;

    try {
      await server?.stop(true);
      await closeTenants(tenants.values());
    } finally {
      identity?.close();
      await release();
    }
  };

  // Bun upgrades require the original incoming Request instance.
  const forward = async (
    request: Request,
    bunServer: Bun.Server<unknown>,
    userId: string,
  ) => {
    const context = await tenant(userId);

    request.headers.set("authorization", `Bearer ${context.token}`);

    return context.app.fetch(request, bunServer);
  };

  const accountResponse = async (
    request: Request,
    bunServer: Bun.Server<unknown>,
    path: string,
  ) => {
    const session = await identity!.auth.api.getSession({
      headers: request.headers,
    });

    // A viewer link is its own credential: a web view cannot send the owner's session, so without one the link
    // goes to the account it names. A session keeps it within the session's account.
    const owner = session ? undefined : viewerPathOwner(path);

    if (owner && identity!.hasUser(owner) && !closed)
      return forward(request, bunServer, owner);

    if (!session)
      return Response.json({ error: "Sign in required" }, { status: 401 });

    if (closed) return closing();
    const response = await forward(request, bunServer, session.user.id);

    if (response) response.headers.set("Cache-Control", "no-store");

    return response;
  };

  const adminResponse = async (request: Request) => {
    if (closed) return closing();
    const response = await admin!.fetch(request);

    response.headers.set("Cache-Control", "no-store");

    return response;
  };

  const restoreTenants = async (accounts: NonNullable<typeof identity>) => {
    const usersDir = accountsDir(dataDir);

    if (!existsSync(usersDir)) return;

    for (const entry of readdirSync(usersDir, { withFileTypes: true })) {
      if (entry.isDirectory() && accounts.hasUser(entry.name))
        await tenant(entry.name);
    }
  };

  try {
    const handle = async (
      request: Request,
      bunServer: Bun.Server<BunWebSocketData>,
    ) => {
      await ready;
      const path = new URL(request.url).pathname;
      const hosted = hostedResponse(path, oauthClient);

      if (hosted) return hosted;

      if (!TENANT_PREFIXES.some((prefix) => path.startsWith(prefix)))
        return new Response("Not found", { status: 404 });
      const requestOrigin = request.headers.get("origin");

      if (untrustedOrigin(request, requestOrigin, trustedOrigins))
        return Response.json({ error: "Untrusted origin" }, { status: 403 });

      // Admins act through /v1/admin/; the plugin's own routes would also let them impersonate users.
      if (path.startsWith("/api/auth/admin/"))
        return new Response("Not found", { status: 404 });

      if (path.startsWith("/api/auth/")) return identity!.auth.handler(request);

      const novnc = await novncResponse(path);

      if (novnc) return novnc;

      if (needsOriginForWrite(request, requestOrigin))
        return Response.json(
          { error: "Origin is required for cookie-authenticated writes" },
          { status: 403 },
        );

      if (path.startsWith("/v1/admin/")) return adminResponse(request);

      return accountResponse(request, bunServer, path);
    };

    server = Bun.serve({
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
    origin = new URL(
      publicUrl ?? process.env["BETTER_AUTH_URL"] ?? server.url.origin,
    ).origin;
    trustedOrigins = trustedOriginsFor(origin);
    ready = (async () => {
      identity = await createAuth(dataDir, origin);
      admin = adminAPI({
        accounts: identity,
        origin: () => origin,
        removeAccount,
        outdatedWorkspaces: async () =>
          (
            await Promise.all(
              [...tenants].map(async ([userId, pending]) =>
                (
                  (
                    await pending.catch(() => undefined)
                  )?.workspaces?.outdated() ?? []
                ).map((agentId) => ({ userId, agentId })),
              ),
            )
          ).flat(),
      });
      await restoreTenants(identity);
    })();
    await ready;

    return { server, auth: identity!.auth, close };
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
