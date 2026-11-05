import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
  connectFakePasswordManager,
  fakePasswordManager,
  fakeVendor,
  type FakePasswordManager,
} from "../../test/support/fake-password-manager";
import { secretsLayer } from "../secrets/secrets";
import { productLayer } from "../app/product-layer";
import { ProviderCredentials } from "./provider-credentials";
import { hostModels } from "./providers";

const REFERENCE = "op://Vault/OpenAI/key";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The account's provider credential store over a fake 1Password, with openai's API key pointing at `REFERENCE`. */
const setup = (state: FakePasswordManager) => {
  const dir = mkdtempSync(join(tmpdir(), "crumble-provider-credentials-"));
  const scope = Scope.makeUnsafe();

  cleanups.push(() => {
    Effect.runSync(Scope.close(scope, Exit.void));
    rmSync(dir, { recursive: true, force: true });
  });

  const context = Effect.runSync(
    Layer.buildWithScope(
      ProviderCredentials.layer.pipe(
        Layer.provideMerge(secretsLayer([fakeVendor(state)])),
        Layer.provideMerge(productLayer(dir)),
      ),
      scope,
    ),
  );

  Effect.runSync(connectFakePasswordManager.pipe(Effect.provide(context)));

  const db = new Database(join(dir, "store.sqlite"));
  db.run("PRAGMA foreign_keys = ON");
  db.run(
    "INSERT INTO provider_credentials (provider, type) VALUES ('openai', 'api_key')",
  );
  db.run(
    `INSERT INTO credentials (key, password_manager, reference) VALUES ('provider:openai', '1password', '${REFERENCE}')`,
  );
  db.close();

  return Context.get(context, ProviderCredentials);
};

test("an API key from a password manager reaches the model's auth", async () => {
  const credentials = setup(fakePasswordManager({ [REFERENCE]: "sk-vault" }));

  expect(
    (await hostModels(credentials, []).getAuth("openai"))?.auth.apiKey,
  ).toBe("sk-vault");
});

test("a model call says which API key couldn't be read, and why", async () => {
  const credentials = setup(fakePasswordManager());

  await expect(hostModels(credentials, []).getAuth("openai")).rejects.toThrow(
    "Credential store read failed for openai: API key could not be read: Fake has no item that matches",
  );
});

test("saving a key replaces the reference without asking the password manager", async () => {
  const state = { ...fakePasswordManager(), mode: "unreachable" as const };
  const credentials = setup(state);

  await credentials.modify("openai", async () => ({
    type: "api_key",
    key: "sk-typed",
  }));

  expect(state.reads).toBe(0);
  expect(await credentials.read("openai")).toEqual({
    type: "api_key",
    key: "sk-typed",
  });
});

test("a key's reference is read when saved, and replacing or deleting it changes what the model gets", async () => {
  const state = fakePasswordManager({
    [REFERENCE]: "sk-vault",
    "op://Vault/OpenAI/other": "sk-other",
  });

  const credentials = setup(state);

  const source = {
    passwordManager: "1password",
    reference: REFERENCE,
  } as const;

  const key = async () => {
    const credential = await credentials.read("openai");

    return credential?.type === "api_key" ? credential.key : undefined;
  };

  expect(await key()).toBe("sk-vault");
  expect(await key()).toBe("sk-vault");
  expect(state.reads).toBe(1);

  await credentials.setApiKey("openai", {
    reference: { ...source, reference: "op://Vault/OpenAI/other" },
  });
  expect(state.reads).toBe(2);
  expect(await key()).toBe("sk-other");

  await credentials.setApiKey("openai", { reference: source });
  expect(await key()).toBe("sk-vault");

  await credentials.delete("openai");
  expect(await credentials.read("openai")).toBeUndefined();
});
