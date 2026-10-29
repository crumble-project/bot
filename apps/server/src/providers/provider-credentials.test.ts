import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect";
import {
  FAKE_TOKEN,
  fakePasswordManager,
  fakeVendor,
  type FakePasswordManager,
} from "../../test/support/fake-password-manager";
import { PasswordManagers } from "../password-managers/password-manager";
import { PasswordManagerRepository } from "../password-managers/password-manager-repository";
import { SecretValues } from "../password-managers/secret-values";
import { productLayer } from "../shared/product-layer";
import { ProviderCredentials } from "./provider-credentials";
import { providerModels } from "./providers";

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
        Layer.provideMerge(
          SecretValues.layer.pipe(
            Layer.provideMerge(PasswordManagers.layer([fakeVendor(state)])),
          ),
        ),
        Layer.provideMerge(productLayer(dir)),
      ),
      scope,
    ),
  );

  Effect.runSync(
    PasswordManagerRepository.use((repository) =>
      repository.save("1password", Redacted.make(FAKE_TOKEN), "t"),
    ).pipe(Effect.provide(context)),
  );

  const db = new Database(join(dir, "store.sqlite"));
  db.run("PRAGMA foreign_keys = ON");
  db.run(
    `INSERT INTO provider_credentials (provider, type, password_manager, reference) VALUES ('openai', 'api_key', '1password', '${REFERENCE}')`,
  );
  db.close();

  return Context.get(context, ProviderCredentials);
};

test("an API key from a password manager reaches the model's auth", async () => {
  const credentials = setup(fakePasswordManager({ [REFERENCE]: "sk-vault" }));

  expect(
    (await providerModels(credentials).getAuth("openai"))?.auth.apiKey,
  ).toBe("sk-vault");
});

test("a model call says which API key couldn't be read, and why", async () => {
  const credentials = setup(fakePasswordManager());

  await expect(providerModels(credentials).getAuth("openai")).rejects.toThrow(
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
