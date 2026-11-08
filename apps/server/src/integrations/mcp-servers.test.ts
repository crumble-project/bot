import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect } from "effect";
import { BotDeletion } from "../bot-ports/bot-deletion";
import { Secrets } from "../secrets/secrets";
import { Store } from "../../test/support/store";
import { mcpServersOver } from "./integrations-test-support";
import { McpServerRepository } from "./mcp-server-repository";
import { fakeAuthorizationServer, gate } from "./mcp-oauth-test-support";
import {
  finishAuthorization,
  hasOAuthTokens,
  secretStorage,
  startAuthorization,
} from "./mcp-oauth";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

test("client-secret updates fence old exchanges and deletion rejects old snapshots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-mcp-secret-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeAuthorizationServer();
  cleanups.push(fake.close);
  const store = new Store(dir);
  cleanups.push(() => store.close());

  const server = store.createMCPServer({
    name: "Test",
    url: fake.url,
    enabled: true,
    oauthClientId: "owner-client",
  });

  const disconnect = gate();

  const context = Context.add(
    store.runtime.runSync(Effect.context()),
    BotDeletion,
    BotDeletion.of({
      register: () => Effect.void,
      prepare: () => Effect.succeed(Effect.void),
    }),
  );

  const secretMutation = gate();
  const realSecrets = Context.get(context, Secrets);

  const gatedContext = Context.add(
    context,
    Secrets,
    Secrets.of({
      ...realSecrets,
      save: (key, input, verify) =>
        Effect.andThen(
          Effect.promise(() => secretMutation.wait()),
          realSecrets.save(key, input, verify),
        ),
    }),
  );

  const service = mcpServersOver(gatedContext, {
    oauthClient: undefined,
    failure: () => null,
    extensionsForAgent: async () => [],
    codemodeNamespaces: () => [],
    disconnect: () => Effect.promise(() => disconnect.wait()),
  });

  const storage = secretStorage(store.runtime);

  const started = await startAuthorization(
    storage,
    server,
    "dev.crumble.desktop:/oauth/callback",
  );

  if (!("authorizationUrl" in started))
    throw new Error("expected authorization URL");
  const exchange = gate();
  fake.gateExchange(exchange);

  const finish = finishAuthorization(
    storage,
    server,
    "code",
    new URL(started.authorizationUrl).searchParams.get("state")!,
  );

  await exchange.reached;

  const update = Effect.runPromise(
    service.update(server, {
      name: server.name,
      url: server.url,
      enabled: true,
      oauthClientId: server.oauthClientId,
      oauthClientSecret: { value: "new-secret" },
    }),
  );

  await secretMutation.reached;
  fake.gateExchange(undefined);

  const admitted = await startAuthorization(
    storage,
    server,
    "dev.crumble.desktop:/oauth/callback",
  );

  if (!("authorizationUrl" in admitted))
    throw new Error("expected authorization URL");
  await finishAuthorization(
    storage,
    server,
    "new",
    new URL(admitted.authorizationUrl).searchParams.get("state")!,
  );
  expect(hasOAuthTokens(storage, server.id)).toBe(true);
  secretMutation.release();
  await disconnect.reached;
  expect(hasOAuthTokens(storage, server.id)).toBe(false);
  exchange.release();
  await expect(finish).rejects.toThrow("expired");
  expect(hasOAuthTokens(storage, server.id)).toBe(false);
  disconnect.release();
  await update;
  await Effect.runPromise(service.delete(server.id));
  await expect(
    startAuthorization(storage, server, "dev.crumble.desktop:/oauth/callback"),
  ).rejects.toThrow("expired");
});

test("token-only updates disconnect before publishing other changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-mcp-token-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  cleanups.push(() => store.close());

  const server = store.createMCPServer({
    name: "Old",
    url: "https://example.test/mcp",
    enabled: true,
  });

  const disconnect = gate();

  const context = Context.add(
    store.runtime.runSync(Effect.context()),
    BotDeletion,
    BotDeletion.of({
      register: () => Effect.void,
      prepare: () => Effect.succeed(Effect.void),
    }),
  );

  const service = mcpServersOver(context, {
    oauthClient: undefined,
    failure: () => null,
    extensionsForAgent: async () => [],
    codemodeNamespaces: () => [],
    disconnect: () => Effect.promise(() => disconnect.wait()),
  });

  const update = Effect.runPromise(
    service.update(server, {
      name: "New",
      url: server.url,
      enabled: true,
      token: { value: "token" },
    }),
  );

  await disconnect.reached;
  expect(
    store.runtime.runSync(
      McpServerRepository.use((repository) => repository.get(server.id)),
    )?.name,
  ).toBe("Old");
  disconnect.release();
  await update;
  expect(
    store.runtime.runSync(
      McpServerRepository.use((repository) => repository.get(server.id)),
    )?.name,
  ).toBe("New");
});

test("client update rejects old snapshots and admits the published client during disconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-mcp-update-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeAuthorizationServer();
  cleanups.push(fake.close);
  const store = new Store(dir);
  cleanups.push(() => store.close());

  const old = store.createMCPServer({
    name: "Test",
    url: fake.url,
    enabled: true,
  });

  const disconnect = gate();

  const context = Context.add(
    store.runtime.runSync(Effect.context()),
    BotDeletion,
    BotDeletion.of({
      register: () => Effect.void,
      prepare: () => Effect.succeed(Effect.void),
    }),
  );

  const service = mcpServersOver(context, {
    oauthClient: undefined,
    failure: () => null,
    extensionsForAgent: async () => [],
    codemodeNamespaces: () => [],
    disconnect: () => Effect.promise(() => disconnect.wait()),
  });

  const update = Effect.runPromise(
    service.update(old, {
      name: old.name,
      url: old.url,
      enabled: true,
      oauthClientId: "new-client",
    }),
  );

  await disconnect.reached;
  await expect(
    startAuthorization(
      secretStorage(store.runtime),
      old,
      "dev.crumble.desktop:/oauth/callback",
    ),
  ).rejects.toThrow("expired");

  const started = await Effect.runPromise(
    service.startSignIn(old.id, "dev.crumble.desktop:/oauth/callback"),
  );

  if (!("authorizationUrl" in started))
    throw new Error("expected authorization URL");
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;

  const current = store.runtime.runSync(
    McpServerRepository.use((repository) => repository.get(old.id)),
  );

  if (!current) throw new Error("server disappeared");
  await finishAuthorization(
    secretStorage(store.runtime),
    current,
    "code",
    state,
  );
  disconnect.release();
  await update;
  expect(hasOAuthTokens(secretStorage(store.runtime), old.id)).toBe(true);
});
