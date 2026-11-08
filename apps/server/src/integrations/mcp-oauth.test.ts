import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent } from "../contract/agents";
import type { MCPServer } from "./mcp-server-repository";
import type { McpTransport } from "@earendil-works/pi-mcp";
import type { MCPClient } from "./integrations";
import { standaloneIntegrations } from "./integrations-test-support";
import {
  connectionAuth,
  finishAuthorization,
  hasOAuthTokens,
  secretStorage,
  signOut,
  startAuthorization,
} from "./mcp-oauth";
import { Store } from "../../test/support/store";
import { fakeAuthorizationServer, gate } from "./mcp-oauth-test-support";

const secrets = (store: Store) => secretStorage(store.runtime);

const redirect = "dev.crumble.desktop:/oauth/callback";
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(options?: { issParameter?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "bot-oauth-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeAuthorizationServer(options);
  cleanups.push(fake.close);
  const store = new Store(dir);

  const server = store.createMCPServer({
    name: "Linear",
    url: fake.url,
    enabled: true,
  });

  return { store, server, fake };
}

async function signIn(store: Store, server: MCPServer) {
  const started = await startAuthorization(secrets(store), server, redirect);

  if (!("authorizationUrl" in started))
    throw new Error("expected a sign-in URL");
  await finishAuthorization(
    secrets(store),
    server,
    "code-1",
    new URL(started.authorizationUrl).searchParams.get("state")!,
  );
}

describe("MCP OAuth", () => {
  test("sign-out during exchange cannot restore credentials", async () => {
    const { store, server, fake } = setup();
    const started = await startAuthorization(secrets(store), server, redirect);

    if (!("authorizationUrl" in started))
      throw new Error("expected a sign-in URL");
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const blocked = gate();
    fake.gateExchange(blocked);

    const completion = finishAuthorization(
      secrets(store),
      server,
      "code",
      state,
    );

    await blocked.reached;
    signOut(secrets(store), server.id);
    expect(hasOAuthTokens(secrets(store), server.id)).toBe(false);
    blocked.release();
    await expect(completion).rejects.toThrow();
    expect(hasOAuthTokens(secrets(store), server.id)).toBe(false);
  });

  test("sign-out during registration cannot restore state", async () => {
    const { store, server, fake } = setup();
    const blocked = gate();
    fake.gateRegistration(blocked);
    const startup = startAuthorization(secrets(store), server, redirect);
    await blocked.reached;
    signOut(secrets(store), server.id);
    blocked.release();
    await expect(startup).rejects.toThrow();
    expect(secrets(store).get(`mcp-oauth:${server.id}`)).toBeUndefined();
  });
  test("an old exchange cannot alter a newer sign-in", async () => {
    const { store, server, fake } = setup();
    const first = await startAuthorization(secrets(store), server, redirect);

    if (!("authorizationUrl" in first))
      throw new Error("expected a sign-in URL");
    const blocked = gate();
    fake.gateExchange(blocked);

    const old = finishAuthorization(
      secrets(store),
      server,
      "old",
      new URL(first.authorizationUrl).searchParams.get("state")!,
    );

    await blocked.reached;
    signOut(secrets(store), server.id);
    fake.gateExchange(undefined);
    await signIn(store, server);
    const key = `mcp-oauth:${server.id}`;
    const before = secrets(store).get(key);
    blocked.release();
    await expect(old).rejects.toThrow();
    expect(secrets(store).get(key)).toBe(before);
    expect(hasOAuthTokens(secrets(store), server.id)).toBe(true);
  });

  test("old completion cannot consume a newer pending callback", async () => {
    const { store, server, fake } = setup();
    const first = await startAuthorization(secrets(store), server, redirect);

    if (!("authorizationUrl" in first)) throw new Error("expected sign-in URL");
    const blocked = gate();
    fake.gateExchange(blocked);

    const old = finishAuthorization(
      secrets(store),
      server,
      "old",
      new URL(first.authorizationUrl).searchParams.get("state")!,
    );

    await blocked.reached;
    signOut(secrets(store), server.id);
    const second = await startAuthorization(secrets(store), server, redirect);

    if (!("authorizationUrl" in second))
      throw new Error("expected sign-in URL");
    const before = secrets(store).get(`mcp-oauth:${server.id}`);
    fake.gateExchange(undefined);
    blocked.release();
    await expect(old).rejects.toThrow();
    expect(secrets(store).get(`mcp-oauth:${server.id}`)).toBe(before);
    await finishAuthorization(
      secrets(store),
      server,
      "new",
      new URL(second.authorizationUrl).searchParams.get("state")!,
    );
    expect(hasOAuthTokens(secrets(store), server.id)).toBe(true);
  });

  test("startup cannot adopt a generation after client-secret lookup", async () => {
    const { store, server } = setup();

    const configured = store.updateMCPServer(server.id, {
      oauthClientId: "owner-client",
    })!;

    const blocked = gate();
    const storage = secrets(store);

    const startup = startAuthorization(
      {
        ...storage,
        clientSecret: async () => {
          await blocked.wait();

          return "client-secret";
        },
      },
      configured,
      redirect,
    );

    await blocked.reached;
    signOut(secrets(store), server.id);
    blocked.release();
    await expect(startup).rejects.toThrow();
    expect(storage.get(`mcp-oauth:${server.id}`)).toBeUndefined();
  });

  test("legacy tokens are preserved and identities change after sign-out", async () => {
    const { store, server } = setup();
    await signIn(store, server);
    const storage = secrets(store);
    const key = `mcp-oauth:${server.id}`;
    const saved = JSON.parse(storage.get(key)!);
    delete saved.generation;
    storage.set(key, JSON.stringify(saved));
    expect(hasOAuthTokens(storage, server.id)).toBe(true);
    await connectionAuth(storage, server);
    const first = JSON.parse(storage.get(key)!);
    expect(first.generation).toBeTruthy();
    expect(first.state.tokens.access_token).toBe(
      saved.state.tokens.access_token,
    );
    signOut(secrets(store), server.id);
    await startAuthorization(secrets(store), server, redirect);
    expect(JSON.parse(storage.get(key)!).generation).not.toBe(first.generation);
  });

  test("completion and connection cannot adopt a generation after client-secret lookup", async () => {
    const { store, server } = setup();

    const configured = store.updateMCPServer(server.id, {
      oauthClientId: "owner-client",
    })!;

    const storage = secrets(store);
    const started = await startAuthorization(storage, configured, redirect);

    if (!("authorizationUrl" in started))
      throw new Error("expected authorization URL");
    const blocked = gate();

    const deferred = {
      ...storage,
      clientSecret: async () => {
        await blocked.wait();

        return undefined;
      },
    };

    const completion = finishAuthorization(
      deferred,
      configured,
      "code",
      new URL(started.authorizationUrl).searchParams.get("state")!,
    );

    await blocked.reached;
    signOut(storage, configured.id);
    blocked.release();
    await expect(completion).rejects.toThrow("expired");
    await signIn(store, configured);
    const blockedConnection = gate();

    const connection = connectionAuth(
      {
        ...storage,
        clientSecret: async () => {
          await blockedConnection.wait();

          return undefined;
        },
      },
      configured,
    );

    await blockedConnection.reached;
    signOut(storage, configured.id);
    blockedConnection.release();
    await expect(connection).rejects.toThrow("expired");
    expect(hasOAuthTokens(storage, configured.id)).toBe(false);
  });

  test("connection admission rejects stored credentials for a different client", async () => {
    const { store, server } = setup();
    await signIn(store, server);

    const changed = store.updateMCPServer(server.id, {
      oauthClientId: "other-client",
    })!;

    await expect(connectionAuth(secrets(store), changed)).rejects.toThrow(
      "expired",
    );
  });

  for (const { name, refused, signInAgain } of [
    { name: "successful refresh", refused: false, signInAgain: false },
    {
      name: "successful refresh after new sign-in",
      refused: false,
      signInAgain: true,
    },
    {
      name: "failed refresh after new sign-in",
      refused: true,
      signInAgain: true,
    },
  ]) {
    test(`sign-out rejects an old ${name}`, async () => {
      const { store, server, fake } = setup();
      await signIn(store, server);
      const storage = secrets(store);
      const key = `mcp-oauth:${server.id}`;
      const saved = JSON.parse(storage.get(key)!);
      saved.state.tokensExpireAt = 0;
      storage.set(key, JSON.stringify(saved));
      const auth = await connectionAuth(storage, server);

      if (!auth) throw new Error("expected OAuth provider");
      const blocked = gate();
      fake.gateRefresh(blocked);

      if (!auth.onUnauthorized) throw new Error("expected refresh support");

      const refresh = auth.onUnauthorized({
        serverUrl: new URL(server.url),
        response: new Response("unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${fake.issuer}/.well-known/oauth-protected-resource/mcp"`,
          },
        }),
        token: saved.state.tokens.access_token,
        fetch,
      });

      await blocked.reached;
      signOut(secrets(store), server.id);

      if (signInAgain) await signIn(store, server);

      const current = storage.get(key);

      if (refused) fake.refuseRefresh();

      blocked.release();
      await expect(refresh).rejects.toThrow();
      expect(storage.get(key)).toBe(current);
      expect(hasOAuthTokens(storage, server.id)).toBe(signInAgain);
    });
  }

  test("persistence faults reject invalidation, provider saves, and completion cleanup", async () => {
    const { store, server } = setup();
    const storage = secrets(store);
    const key = `mcp-oauth:${server.id}`;
    expect(() =>
      signOut(
        {
          ...storage,
          delete: () => {
            throw new Error("delete fault");
          },
        },
        server.id,
      ),
    ).toThrow("delete fault");
    let failSave = true;
    let savesAfterFault = 0;

    const failingSave = {
      ...storage,
      set: (k: string, value: string) => {
        if (failSave && JSON.parse(value).state.clientInformation) {
          failSave = false;
          throw new Error("save fault");
        }

        if (!failSave) savesAfterFault++;
        storage.set(k, value);
      },
    };

    await expect(
      startAuthorization(failingSave, server, redirect),
    ).rejects.toThrow("save fault");
    expect(savesAfterFault).toBe(0);
    signOut(storage, server.id);
    const started = await startAuthorization(storage, server, redirect);

    if (!("authorizationUrl" in started))
      throw new Error("expected authorization URL");
    let cleanupFailed = false;
    let writesAfterCleanup = 0;

    const failingCleanup = {
      ...storage,
      set: (k: string, value: string) => {
        const next = JSON.parse(value);

        if (!cleanupFailed && next.state.tokens && !next.state.oauthState) {
          cleanupFailed = true;
          throw new Error("cleanup fault");
        }

        if (cleanupFailed) writesAfterCleanup++;
        storage.set(k, value);
      },
    };

    await expect(
      finishAuthorization(
        failingCleanup,
        server,
        "code",
        new URL(started.authorizationUrl).searchParams.get("state")!,
      ),
    ).rejects.toThrow("cleanup fault");
    expect(cleanupFailed).toBe(true);
    expect(writesAfterCleanup).toBe(0);
    expect(JSON.parse(storage.get(key)!).state.oauthState).toBeTruthy();
  });

  test("signs in with a registered client, PKCE, and a checked state", async () => {
    const { store, server, fake } = setup();
    const started = await startAuthorization(secrets(store), server, redirect);

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
      finishAuthorization(secrets(store), server, "code-1", "stale"),
    ).rejects.toThrow("expired");
    await finishAuthorization(secrets(store), server, "code-1", state);
    expect(hasOAuthTokens(secrets(store), server.id)).toBe(true);
    const exchange = fake.tokenRequests[0]!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("code-1");
    expect(
      createHash("sha256")
        .update(exchange.get("code_verifier") ?? "")
        .digest("base64url"),
    ).toBe(url.searchParams.get("code_challenge")!);
    await expect(
      finishAuthorization(secrets(store), server, "code-1", state),
    ).rejects.toThrow("expired");

    signOut(secrets(store), server.id);
    expect(hasOAuthTokens(secrets(store), server.id)).toBe(false);
  });

  test("checks the issuer a server returns with the code (RFC 9207)", async () => {
    const { store, server, fake } = setup({ issParameter: true });
    const started = await startAuthorization(secrets(store), server, redirect);

    if (!("authorizationUrl" in started))
      throw new Error("expected a sign-in URL");
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await expect(
      finishAuthorization(
        secrets(store),
        server,
        "code-1",
        state,
        "https://evil.test",
      ),
    ).rejects.toThrow("Linear could not finish OAuth sign-in");
    await finishAuthorization(
      secrets(store),
      server,
      "code-1",
      state,
      fake.issuer,
    );
    expect(hasOAuthTokens(secrets(store), server.id)).toBe(true);
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

    await expect(
      startAuthorization(secrets(store), server, redirect),
    ).rejects.toThrow("Plain could not start OAuth sign-in");
  });

  test("an expired sign-in leaves the server out and asks to sign in again", async () => {
    const { store, server, fake } = setup();
    await signIn(store, server);
    fake.refuseRefresh();
    const { integrations, close } = standaloneIntegrations(store.runtime);
    // SAFETY: OAuth integration only reads these Agent fields in this fixture.
    const agent = { id: "a1", mcpServers: [server.id] } as Agent;
    const extensions = await integrations.extensionsForAgent(agent);

    // SAFETY: MCP extensions expose their registered tool list.
    expect(extensions.flatMap((extension) => (extension as any).tools)).toEqual(
      [],
    );
    expect(integrations.failure(server.id)).toContain(
      "Sign in to Linear again under Integrations",
    );
    await close();
  });

  test("signed-in servers connect through OAuth instead of a stored token", async () => {
    const { store, server } = setup();
    store.setCredential(`mcp:${server.id}`, "static-token");
    const started = await startAuthorization(secrets(store), server, redirect);

    if (!("authorizationUrl" in started))
      throw new Error("expected a sign-in URL");
    await finishAuthorization(
      secrets(store),
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

    const { integrations, close } = standaloneIntegrations(store.runtime, {
      clientFactory: (_server, headers, authProvider) => {
        calls.push({ headers, oauth: Boolean(authProvider) });

        return {
          client,
          // SAFETY: The fake client never uses transport beyond close().
          transport: { close: async () => {} } as McpTransport,
        };
      },
    });

    // SAFETY: OAuth integration only reads these Agent fields in this fixture.
    const agent = { id: "a1", mcpServers: [server.id] } as Agent;
    await integrations.extensionsForAgent(agent);
    expect(calls).toEqual([{ headers: {}, oauth: true }]);
    await close();
  });
});
