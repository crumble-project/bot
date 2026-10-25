import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { websocket } from "@hono/bun";
import { createAuth } from "./auth";
import { novncResponse, ticketOwner } from "../bot-desktop/desktop-viewer";
import { createTenant } from "./tenant";
import { webUIRoutes } from "./web-ui";
import {
  CLIENT_DOCUMENT_PATH,
  clientDocument,
  clientDocumentBody,
} from "../integrations/mcp-oauth";
import type { Workspaces } from "../workspaces/workspace";

export async function startServer(
  options: {
    dataDir?: string;
    hostname?: string;
    port?: number;
    publicUrl?: string;
    skillsDir?: string;
    workspaces?: (userId: string) => Workspaces;
  } = {},
) {
  const dataDir = resolve(
    options.dataDir ?? process.env["CRUMBLE_DATA_DIR"] ?? "./data",
  );

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  const release = await lockfile.lock(dataDir, {
    stale: 30000,
    update: 10000,
    retries: 0,
  });

  const tenants = new Map<
    string,
    Promise<Awaited<ReturnType<typeof createTenant>>>
  >();

  let identity: Awaited<ReturnType<typeof createAuth>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let closed = false;
  const publicUrl = options.publicUrl ?? process.env["CRUMBLE_PUBLIC_URL"];
  let origin = "";
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
      const settled = await Promise.allSettled(tenants.values());

      const results = await Promise.allSettled(
        settled.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.close()] : [],
        ),
      );

      const failed = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );

      if (failed.length)
        throw new AggregateError(failed, "Tenant shutdown failed");
    } finally {
      identity?.close();
      await release();
    }
  };

  try {
    if (publicUrl) {
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
    }

    const oauthClient = publicUrl
      ? clientDocument(new URL(publicUrl))
      : undefined;

    server = Bun.serve({
      routes: webUIRoutes,
      development: process.env.NODE_ENV !== "production" && { hmr: false },
      websocket,
      hostname: options.hostname ?? process.env["CRUMBLE_HOST"] ?? "127.0.0.1",
      port: options.port ?? Number(process.env["CRUMBLE_PORT"] ?? 7337),
      idleTimeout: 60,
      async fetch(request, bunServer) {
        await ready;
        const path = new URL(request.url).pathname;

        if (path === "/health")
          return Response.json({ status: "ok", apiVersion: 1 });

        if (path === CLIENT_DOCUMENT_PATH)
          return oauthClient
            ? Response.json(clientDocumentBody(oauthClient))
            : new Response("Not found", { status: 404 });

        if (
          !path.startsWith("/v1/") &&
          !path.startsWith("/desktop-viewer/") &&
          !path.startsWith("/api/auth/")
        )
          return new Response("Not found", { status: 404 });
        const requestOrigin = request.headers.get("origin");

        if (
          (requestOrigin && requestOrigin !== origin) ||
          request.headers.get("sec-fetch-site") === "cross-site"
        )
          return Response.json({ error: "Untrusted origin" }, { status: 403 });

        if (path.startsWith("/api/auth/"))
          return identity!.auth.handler(request);

        const novnc = await novncResponse(path);

        if (novnc) return novnc;

        if (
          !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
          !requestOrigin &&
          request.headers.has("cookie") &&
          !request.headers.has("authorization")
        )
          return Response.json(
            { error: "Origin is required for cookie-authenticated writes" },
            { status: 403 },
          );

        const session = await identity!.auth.api.getSession({
          headers: request.headers,
        });

        // A viewer link is its own credential: a web view cannot send the owner's session, so without one the link
        // goes to the account it names. A session keeps it within the session's account.
        const owner =
          !session &&
          ticketOwner(
            /^\/desktop-viewer\/([^/]+)(?:\/websockify)?$/.exec(path)?.[1] ??
              "",
          );

        if (owner && identity!.hasUser(owner) && !closed) {
          const context = await tenant(owner);

          request.headers.set("authorization", `Bearer ${context.token}`);

          return context.app.fetch(request, bunServer);
        }

        if (!session)
          return Response.json({ error: "Sign in required" }, { status: 401 });

        if (closed) return new Response("Server is closing", { status: 503 });
        const context = await tenant(session.user.id);
        // Bun upgrades require the original incoming Request instance.
        request.headers.set("authorization", `Bearer ${context.token}`);
        const response = await context.app.fetch(request, bunServer);

        if (response) response.headers.set("Cache-Control", "no-store");

        return response;
      },
    });
    origin = new URL(
      publicUrl ?? process.env["BETTER_AUTH_URL"] ?? server.url.origin,
    ).origin;
    ready = (async () => {
      identity = await createAuth(dataDir, origin);
      const usersDir = join(dataDir, "users");

      if (existsSync(usersDir)) {
        for (const entry of readdirSync(usersDir, { withFileTypes: true })) {
          if (entry.isDirectory() && identity.hasUser(entry.name))
            await tenant(entry.name);
        }
      }
    })();
    await ready;

    return { server, auth: identity!.auth, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (import.meta.main) {
  const running = await startServer();
  console.log(`Crumble server listening on ${running.server.url}`);
  console.log("Open /ui to create an account or sign in.");

  const close = async () => {
    await running.close();
    process.exit(0);
  };

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
