import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect";
import {
  FAKE_TOKEN,
  fakePasswordManager,
  fakeVendor,
  type FakePasswordManager,
} from "../../test/support/fake-password-manager";
import { Store } from "../../test/support/store";
import { handleApiError } from "../app/api";
import { contractApp } from "../contract/api-contract";
import { passwordManagersResponse } from "../contract/api-responses";
import type { CoreServices } from "../shared/core-layer";
import { runnerOf } from "../shared/runner";
import { PasswordManagers } from "./password-manager";
import { registerPasswordManagerRoutes } from "./password-managers-api";
import { SecretValues } from "./secret-values";

const REFERENCE = "op://Vault/Linear/token";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The password manager routes over a fake 1Password holding `REFERENCE`. */
const setup = (state: FakePasswordManager) => {
  const dir = mkdtempSync(join(tmpdir(), "crumble-password-managers-api-"));
  const store = new Store(dir);
  const core = store.run(Effect.context<CoreServices>());
  const scope = Scope.makeUnsafe();

  cleanups.push(() => {
    Effect.runSync(Scope.close(scope, Exit.void));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const vault = Effect.runSync(
    Layer.buildWithScope(
      SecretValues.layer.pipe(
        Layer.provideMerge(PasswordManagers.layer([fakeVendor(state)])),
        Layer.provide(Layer.succeedContext(core)),
      ),
      scope,
    ),
  );

  const run = runnerOf(Context.merge(core, vault));
  const app = contractApp();

  app.onError(handleApiError);
  registerPasswordManagerRoutes({
    register: (definition, handler) =>
      app.on(definition.method, definition.getRoutingPath(), handler),
    run,
  });

  const request = (method: string, token?: string) =>
    app.request("/v1/password-managers/1password", {
      method,
      headers: { "content-type": "application/json" },
      ...(token !== undefined && { body: JSON.stringify({ token }) }),
    });

  return {
    run,
    connect: (token = FAKE_TOKEN) => request("PUT", token),
    disconnect: () => request("DELETE"),
    list: async () =>
      passwordManagersResponse.parse(
        await (await app.request("/v1/password-managers")).json(),
      ),
    read: () =>
      SecretValues.use((values) =>
        values.read({ passwordManager: "1password", reference: REFERENCE }),
      ),
    useReference: () => {
      const db = new Database(join(dir, "store.sqlite"));
      db.run(
        `INSERT INTO credentials (key, password_manager, reference) VALUES ('mcp:server', '1password', '${REFERENCE}')`,
      );
      db.close();
    },
  };
};

test("connecting with a token the password manager accepts lists it as connected", async () => {
  const api = setup(fakePasswordManager());

  expect((await api.list()).passwordManagers).toEqual([
    expect.objectContaining({ id: "1password", connected: false }),
  ]);

  const response = await api.connect();

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: "1password",
    name: "Fake",
    connected: true,
  });
  expect((await api.list()).passwordManagers[0]?.connected).toBe(true);
});

test("a rejected token answers 400 and leaves the password manager disconnected", async () => {
  const api = setup(fakePasswordManager());
  const response = await api.connect("wrong");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Fake rejected" });
  expect((await api.list()).passwordManagers[0]?.connected).toBe(false);
});

test("a new token drops the values read with the old one", async () => {
  const state = fakePasswordManager({ [REFERENCE]: "lin_value" });
  const api = setup(state);
  await api.connect();

  await api.run.runPromise(api.read());
  await api.run.runPromise(api.read());
  expect(state.reads).toBe(1);

  expect((await api.connect()).status).toBe(200);
  await api.run.runPromise(api.read());
  expect(state.reads).toBe(2);
});

test("a new token interrupts a read in flight and doesn't cache its value", async () => {
  const state = fakePasswordManager({ [REFERENCE]: "lin_value" });
  const api = setup(state);
  await api.connect();
  state.mode = "hang";

  const reading = api.run.runFork(api.read());
  await Effect.runPromise(Effect.yieldNow);
  expect((await api.connect()).status).toBe(200);

  expect(Exit.isFailure(await Effect.runPromise(Fiber.await(reading)))).toBe(
    true,
  );
  expect(state.interrupted).toBe(1);

  state.mode = "answer";
  await api.run.runPromise(api.read());
  expect(state.reads).toBe(2);
});

test("disconnecting while a secret reads from the password manager answers 409 and names it", async () => {
  const api = setup(fakePasswordManager());
  await api.connect();
  api.useReference();

  expect((await api.disconnect()).status).toBe(409);
  expect((await api.list()).passwordManagers[0]?.usedBy).toEqual([
    { kind: "secret", key: "mcp:server" },
  ]);
});

test("disconnecting a password manager no secret uses answers 204", async () => {
  const api = setup(fakePasswordManager());
  await api.connect();

  expect((await api.disconnect()).status).toBe(204);
  expect((await api.list()).passwordManagers[0]?.connected).toBe(false);
});
