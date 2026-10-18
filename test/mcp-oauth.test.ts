import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent } from "../src/domain";
import type { McpTransport } from "@earendil-works/pi-mcp";
import { MCPIntegrations, type MCPClient } from "../src/integrations";
import {
  finishAuthorization,
  hasOAuthTokens,
  signOut,
  startAuthorization,
} from "../src/mcp-oauth";
import { Store } from "../src/store";

const redirect = "dev.crumble.desktop:/oauth/callback";
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** An MCP server's OAuth side: resource metadata, authorization server metadata, registration and tokens. */
function fakeAuthorizationServer() {
  const tokenRequests: URLSearchParams[] = [];
  let refreshRefused = false;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = url.origin;
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (url.pathname === "/register" && request.method === "POST")
        return Response.json(
          {
            ...((await request.json()) as Record<string, unknown>),
            client_id: "crumble-client",
          },
          { status: 201 },
        );
      if (url.pathname === "/token" && request.method === "POST") {
        const params = new URLSearchParams(await request.text());
        tokenRequests.push(params);
        if (refreshRefused && params.get("grant_type") === "refresh_token")
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({
          access_token: `access-${tokenRequests.length}`,
          token_type: "Bearer",
          refresh_token: "refresh-1",
          expires_in: 3600,
        });
      }
      // The MCP endpoint refuses every token, as it would once a sign-in has lapsed.
      if (url.pathname === "/mcp")
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      return new Response("not found", { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    tokenRequests,
    refuseRefresh: () => {
      refreshRefused = true;
    },
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bot-oauth-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeAuthorizationServer();
  const store = new Store(dir);
  const server = store.createMCPServer({
    name: "Linear",
    url: fake.url,
    enabled: true,
  });
  return { store, server, fake };
}

async function signIn(
  store: Store,
  server: { id: string; name: string; url: string; enabled: boolean },
) {
  const started = await startAuthorization(store, server, redirect);
  if (!("authorizationUrl" in started))
    throw new Error("expected a sign-in URL");
  await finishAuthorization(
    store,
    server,
    "code-1",
    new URL(started.authorizationUrl).searchParams.get("state")!,
  );
}

describe("MCP OAuth", () => {
  test("signs in with a registered client, PKCE, and a checked state", async () => {
    const { store, server, fake } = setup();
    const started = await startAuthorization(store, server, redirect);
    if (!("authorizationUrl" in started))
      throw new Error("expected a sign-in URL");
    const url = new URL(started.authorizationUrl);
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe("crumble-client");
    expect(url.searchParams.get("redirect_uri")).toBe(redirect);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(10);

    await expect(
      finishAuthorization(store, server, "code-1", "stale"),
    ).rejects.toThrow("expired");
    await finishAuthorization(store, server, "code-1", state);
    expect(hasOAuthTokens(store, server.id)).toBe(true);
    const exchange = fake.tokenRequests[0]!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("code-1");
    expect(exchange.get("code_verifier")?.length).toBeGreaterThan(40);
    // The state answers one attempt only.
    await expect(
      finishAuthorization(store, server, "code-1", state),
    ).rejects.toThrow("expired");

    signOut(store, server.id);
    expect(hasOAuthTokens(store, server.id)).toBe(false);
  });

  test("servers without OAuth metadata explain that they can't sign in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-oauth-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const plain = Bun.serve({
      port: 0,
      fetch: () => new Response("no", { status: 404 }),
    });
    cleanups.push(() => plain.stop(true));
    const store = new Store(dir);
    const server = store.createMCPServer({
      name: "Plain",
      url: `http://127.0.0.1:${plain.port}/mcp`,
      enabled: true,
    });
    await expect(startAuthorization(store, server, redirect)).rejects.toThrow(
      "Plain could not start OAuth sign-in",
    );
  });

  test("an expired sign-in fails with a request to sign in again", async () => {
    const { store, server, fake } = setup();
    await signIn(store, server);
    fake.refuseRefresh();
    const integrations = new MCPIntegrations(store);
    const agent = { id: "a1", mcpServers: [server.id] } as Agent;
    await expect(integrations.extensionsForAgent(agent)).rejects.toThrow(
      "Sign in to Linear again under Integrations",
    );
    await integrations.close();
  });

  test("signed-in servers connect through OAuth instead of a stored token", async () => {
    const { store, server } = setup();
    store.setCredential(`mcp:${server.id}`, "static-token");
    const started = await startAuthorization(store, server, redirect);
    if (!("authorizationUrl" in started))
      throw new Error("expected a sign-in URL");
    await finishAuthorization(
      store,
      server,
      "code-1",
      new URL(started.authorizationUrl).searchParams.get("state")!,
    );
    const calls: { headers: Record<string, string>; oauth: boolean }[] = [];
    const client: MCPClient = {
      connect: async () => {},
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const integrations = new MCPIntegrations(store, {
      clientFactory: (_server, headers, authProvider) => {
        calls.push({ headers, oauth: Boolean(authProvider) });
        return {
          client,
          transport: { close: async () => {} } as unknown as McpTransport,
        };
      },
    });
    const agent = { id: "a1", mcpServers: [server.id] } as Agent;
    await integrations.extensionsForAgent(agent);
    expect(calls).toEqual([{ headers: {}, oauth: true }]);
    await integrations.close();
  });
});
