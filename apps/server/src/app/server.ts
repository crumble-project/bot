import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { websocket } from "@hono/bun";
import { createAuth, trustedOriginsFor } from "./auth";
import { novncResponse, ticketOwner } from "../bot-desktop/desktop-viewer";
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
import { configureDevWorkspaces } from "./dev-workspaces";
import { MASTER_KEY_VARIABLE } from "../shared/secret-box";

const TENANT_PREFIXES = ["/v1/", "/desktop-viewer/", "/api/auth/"];

/** The paths the host answers itself, before any account sees the request. */
function hostedResponse(
  path: string,
  oauthClient: ClientDocument | undefined,
): Response | undefined {
  if (path === "/health") return Response.json({ status: "ok", apiVersion: 1 });

  if (path === CLIENT_DOCUMENT_PATH)
    return oauthClient
      ? Response.json(clientDocumentBody(oauthClient))
      : new Response("Not found", { status: 404 });

  return undefined;
}

/** A request from another site, whether by its origin header or the browser's own mark. */
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

// A viewer link is its own credential: a web view cannot send the owner's session, so without one the link
// goes to the account it names. A session keeps it within the session's account.
function ticketOwnerOf(path: string) {
  return ticketOwner(
    /^\/desktop-viewer\/([^/]+)(?:\/websockify)?$/.exec(path)?.[1] ?? "",
  );
}

function lockRetries(waitMs = 35_000) {
  return { retries: Math.ceil(waitMs / 1000), factor: 1, minTimeout: 1000 };
}

type Tenant = Awaited<ReturnType<typeof createTenant>>;

/** The origin `publicUrl` names; it must be https, without a path, query, or fragment. */
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
  /** How long to wait for another server's lock on the data directory before failing. */
  lockWaitMs?: number;
  /** Each account's workspaces instead of those from the environment, owned by the account's scope. */
  workspaces?: (
    userId: string,
  ) => Effect.Effect<Workspaces | undefined, never, Scope.Scope>;
};

/** Where the server listens and keeps its data: `options`, else the environment, else the defaults. */
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

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  // A process killed without cleanup, as on a watch restart, leaves a fresh lock; outwait its staleness.
  const release = await lockfile.lock(dataDir, {
    stale: 30000,
    update: 10000,
    retries: lockRetries(options.lockWaitMs),
  });

  const tenants = new Map<string, Promise<Tenant>>();

  let identity: Awaited<ReturnType<typeof createAuth>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let closed = false;
  let origin = "";
  let trustedOrigins: string[] = [];
  let ready: Promise<void>;

  const tenant = (userId: string) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId))
      throw new Error("Invalid account ID");
    let pending = tenants.get(userId);

    if (!pending) {
      pending = createTenant({
        dataDir: join(dataDir, "users", userId),
        tenantId: userId,
        skillsDir: options.skillsDir ?? process.env["CRUMBLE_SKILLS_DIR"],
        publicUrl,
        workspaces: options.workspaces?.(userId),
      });
      tenants.set(userId, pending);
      void pending.catch(() => tenants.delete(userId));
    }

    return pending;
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

    const owner = session ? undefined : ticketOwnerOf(path);

    if (owner && identity!.hasUser(owner) && !closed)
      return forward(request, bunServer, owner);

    if (!session)
      return Response.json({ error: "Sign in required" }, { status: 401 });

    if (closed) return new Response("Server is closing", { status: 503 });
    const response = await forward(request, bunServer, session.user.id);

    if (response) response.headers.set("Cache-Control", "no-store");

    return response;
  };

  const restoreTenants = async (accounts: NonNullable<typeof identity>) => {
    const usersDir = join(dataDir, "users");

    if (!existsSync(usersDir)) return;

    for (const entry of readdirSync(usersDir, { withFileTypes: true })) {
      if (entry.isDirectory() && accounts.hasUser(entry.name))
        await tenant(entry.name);
    }
  };

  try {
    const oauthClient = publicUrl
      ? clientDocument(publicOrigin(publicUrl))
      : undefined;

    server = Bun.serve({
      routes: webUIRoutes,
      development: process.env.NODE_ENV !== "production" && { hmr: false },
      websocket,
      hostname,
      port,
      idleTimeout: 60,
      async fetch(request, bunServer) {
        await ready;
        const path = new URL(request.url).pathname;
        const hosted = hostedResponse(path, oauthClient);

        if (hosted) return hosted;

        if (!TENANT_PREFIXES.some((prefix) => path.startsWith(prefix)))
          return new Response("Not found", { status: 404 });
        const requestOrigin = request.headers.get("origin");

        if (untrustedOrigin(request, requestOrigin, trustedOrigins))
          return Response.json({ error: "Untrusted origin" }, { status: 403 });

        if (path.startsWith("/api/auth/"))
          return identity!.auth.handler(request);

        const novnc = await novncResponse(path);

        if (novnc) return novnc;

        if (needsOriginForWrite(request, requestOrigin))
          return Response.json(
            { error: "Origin is required for cookie-authenticated writes" },
            { status: 403 },
          );

        return accountResponse(request, bunServer, path);
      },
    });
    origin = new URL(
      publicUrl ?? process.env["BETTER_AUTH_URL"] ?? server.url.origin,
    ).origin;
    trustedOrigins = trustedOriginsFor(origin);
    ready = (async () => {
      identity = await createAuth(dataDir, origin);
      await restoreTenants(identity);
    })();
    await ready;

    return { server, auth: identity!.auth, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (import.meta.main) {
  if (process.argv.includes("--dev-workspaces"))
    configureDevWorkspaces(process.env);
  const running = await startServer();
  console.log(`Crumble server listening on ${running.server.url}`);
  console.log("Open /ui to create an account or sign in.");

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
