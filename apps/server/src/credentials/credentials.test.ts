import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Scope,
} from "effect";
import { BotNotices } from "../bots/bot-notices";
import { agentInput } from "../shared/domain";
import type { CoreServices } from "../shared/core-layer";
import { runnerOf } from "../shared/runner";
import {
  PasswordManagers,
  type PasswordManagerVendor,
} from "../password-managers/password-manager";
import { PasswordManagerRepository } from "../password-managers/password-manager-repository";
import { SecretValues } from "../password-managers/secret-values";
import {
  FAKE_TOKEN,
  fakePasswordManager,
  fakeVendor,
  type FakePasswordManager,
} from "../../test/support/fake-password-manager";
import { Store } from "../../test/support/store";
import { Credentials } from "./credentials";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "crumble-credentials-"));
  dirs.push(dir);
  const store = new Store(dir);
  const agentId = store.createAgent(agentInput.parse({ name: "Bot" })).id;

  return { store, agentId };
}

type Notice = { agentId: string; text: string; requestId: string };

/** Takes the account's bot notices until the returned scope closes. */
function takeNotices(store: Store) {
  const notices: Notice[] = [];
  const scope = store.runtime.runSync(Scope.make());

  store.runtime.runSync(
    BotNotices.use((botNotices) =>
      botNotices.handle((agentId, text, requestId) =>
        Effect.sync(() => {
          notices.push({ agentId, text, requestId });
        }),
      ),
    ).pipe(Scope.provide(scope)),
  );

  return {
    notices,
    stop: () => store.runtime.runSync(Scope.close(scope, Exit.void)),
  };
}

const credentials = (store: Store) =>
  store.runtime.runSync(Credentials.use(Effect.succeed));

test("saving a requested credential answers the request with a notice to the bot", async () => {
  const { store, agentId } = open();
  const { notices, stop } = takeNotices(store);
  const service = credentials(store);

  await store.runtime.runPromise(
    service.request(agentId, {
      name: "ACME_TOKEN",
      hosts: ["api.acme.com"],
      reason: "Deploys",
    }),
  );
  await store.runtime.runPromise(
    service.save(agentId, "ACME_TOKEN", { value: "secret" }),
  );

  expect(notices).toEqual([
    {
      agentId,
      text: "The owner saved credential ACME_TOKEN for api.acme.com. Coding jobs see it as $ACME_TOKEN.",
      requestId: expect.stringMatching(/^credential:ACME_TOKEN:/),
    },
  ]);
  expect(store.listCredentialRequests(agentId)).toEqual([]);
  stop();
  store.close();
});

test("declining a request notifies the bot, and deleting a credential does not", async () => {
  const { store, agentId } = open();
  const { notices, stop } = takeNotices(store);
  const service = credentials(store);

  await store.runtime.runPromise(
    service.request(agentId, {
      name: "PENDING",
      hosts: ["example.com"],
      reason: "Tests",
    }),
  );
  await store.runtime.runPromise(service.delete(agentId, "PENDING"));
  await store.runtime.runPromise(
    service.save(agentId, "KEPT", { hosts: ["example.com"], value: "v" }),
  );
  await store.runtime.runPromise(service.delete(agentId, "KEPT"));

  expect(notices.map((notice) => notice.text)).toEqual([
    "The owner declined your request for credential PENDING.",
  ]);
  stop();
  store.close();
});

test("a save still succeeds when nothing takes notices", async () => {
  const { store, agentId } = open();
  const service = credentials(store);

  await store.runtime.runPromise(
    service.request(agentId, {
      name: "ACME_TOKEN",
      hosts: ["api.acme.com"],
      reason: "Deploys",
    }),
  );

  expect(
    (
      await store.runtime.runPromise(
        service.save(agentId, "ACME_TOKEN", { value: "secret" }),
      )
    ).name,
  ).toBe("ACME_TOKEN");
  store.close();
});

const REFERENCE = "op://Vault/Acme/token";
const OTHER_REFERENCE = "op://Vault/Acme/other";

const reference = (path = REFERENCE) => ({
  passwordManager: "1password" as const,
  reference: path,
});

/** The bot's credentials over a fake 1Password, connected with its token. */
function withPasswordManager(
  store: Store,
  state: FakePasswordManager,
  vendor: PasswordManagerVendor = fakeVendor(state),
) {
  const core = store.run(Effect.context<CoreServices>());
  const scope = Scope.makeUnsafe();

  const context = Effect.runSync(
    Layer.buildWithScope(
      Credentials.layer.pipe(
        Layer.provideMerge(
          SecretValues.layer.pipe(
            Layer.provideMerge(PasswordManagers.layer([vendor])),
          ),
        ),
        Layer.provide(Layer.succeedContext(core)),
      ),
      scope,
    ),
  );

  store.run(
    PasswordManagerRepository.use((repository) =>
      repository.save("1password", Redacted.make(FAKE_TOKEN), "t"),
    ),
  );

  const run = runnerOf(Context.merge(core, context));

  return {
    run,
    service: Context.get(context, Credentials),
    read: (path: string) =>
      run.runPromise(
        SecretValues.use((values) => values.read(reference(path))),
      ),
    usedBy: () =>
      store.run(
        PasswordManagerRepository.use((repository) =>
          repository.usedBy("1password"),
        ),
      ),
    close: () => {
      Effect.runSync(Scope.close(scope, Exit.void));
      store.close();
    },
  };
}

const failureOf = async (effect: Effect.Effect<unknown, { message: string }>) =>
  Option.getOrUndefined(
    Option.map(
      Exit.findErrorOption(await Effect.runPromiseExit(effect)),
      (error) => error.message,
    ),
  );

test("a credential saved as a reference reads the password manager's value", async () => {
  const { store, agentId } = open();

  const vault = withPasswordManager(
    store,
    fakePasswordManager({ [REFERENCE]: "vault-secret" }),
  );

  const saved = await vault.run.runPromise(
    vault.service.save(agentId, "ACME_TOKEN", {
      hosts: ["api.acme.com"],
      reference: reference(),
    }),
  );

  expect(saved).toMatchObject({
    passwordManager: "1password",
    reference: REFERENCE,
  });
  expect(
    Redacted.value(
      await vault.run.runPromise(vault.service.value(agentId, "ACME_TOKEN")),
    ),
  ).toBe("vault-secret");
  vault.close();
});

test("a reference that can't be read rejects the save and writes nothing", async () => {
  const { store, agentId } = open();
  const state = fakePasswordManager();
  const vault = withPasswordManager(store, state);

  const save = () =>
    vault.service.save(agentId, "ACME_TOKEN", {
      hosts: ["api.acme.com"],
      reference: reference(),
    });

  expect(await failureOf(save())).toBe("Fake has no item that matches");

  state.mode = "unreachable";

  expect(await failureOf(save())).toBe("Fake could not be reached");
  expect(store.run(vault.service.list(agentId)).credentials).toEqual([]);
  vault.close();
});

test("answering a credential request with a reference starts the bot turn", async () => {
  const { store, agentId } = open();
  const { notices, stop } = takeNotices(store);

  const vault = withPasswordManager(
    store,
    fakePasswordManager({ [REFERENCE]: "vault-secret" }),
  );

  await vault.run.runPromise(
    vault.service.request(agentId, {
      name: "ACME_TOKEN",
      hosts: ["api.acme.com"],
      reason: "Deploys",
    }),
  );
  await vault.run.runPromise(
    vault.service.save(agentId, "ACME_TOKEN", { reference: reference() }),
  );

  expect(notices.map((notice) => notice.text)).toEqual([
    "The owner saved credential ACME_TOKEN for api.acme.com. Coding jobs see it as $ACME_TOKEN.",
  ]);
  expect(store.listCredentialRequests(agentId)).toEqual([]);
  stop();
  vault.close();
});

test("replacing a reference with a value reads nothing from the password manager and frees it", async () => {
  const { store, agentId } = open();
  const state = fakePasswordManager({ [REFERENCE]: "vault-secret" });
  const vault = withPasswordManager(store, state);

  await vault.run.runPromise(
    vault.service.save(agentId, "ACME_TOKEN", {
      hosts: ["api.acme.com"],
      reference: reference(),
    }),
  );
  expect(vault.usedBy()).toHaveLength(1);

  const saved = await vault.run.runPromise(
    vault.service.save(agentId, "ACME_TOKEN", { value: "stored" }),
  );

  expect(saved).toMatchObject({ passwordManager: null, reference: null });
  expect(
    Redacted.value(
      await vault.run.runPromise(vault.service.value(agentId, "ACME_TOKEN")),
    ),
  ).toBe("stored");
  expect(state.reads).toBe(1);
  expect(vault.usedBy()).toEqual([]);
  vault.close();
});

test("changing or deleting a reference forgets its cached value", async () => {
  const { store, agentId } = open();

  const state = fakePasswordManager({
    [REFERENCE]: "vault-secret",
    [OTHER_REFERENCE]: "other-secret",
  });

  const vault = withPasswordManager(store, state);

  await vault.run.runPromise(
    vault.service.save(agentId, "ACME_TOKEN", {
      hosts: ["api.acme.com"],
      reference: reference(),
    }),
  );
  await vault.read(REFERENCE);
  expect(state.reads).toBe(1);

  await vault.run.runPromise(
    vault.service.save(agentId, "ACME_TOKEN", {
      reference: reference(OTHER_REFERENCE),
    }),
  );
  await vault.read(REFERENCE);
  expect(state.reads).toBe(3);

  await vault.run.runPromise(vault.service.delete(agentId, "ACME_TOKEN"));
  await vault.read(OTHER_REFERENCE);
  expect(state.reads).toBe(4);
  vault.close();
});

test("a host change made while a reference is checked is kept", async () => {
  const { store, agentId } = open();
  const state = fakePasswordManager({ [REFERENCE]: "vault-secret" });
  const gate = Effect.runSync(Deferred.make<void>());
  const fake = fakeVendor(state);

  // Reads wait for the gate, so the test can save in between.
  const vendor: PasswordManagerVendor = {
    ...fake,
    signIn: (token) =>
      fake.signIn(token).pipe(
        Effect.map((client) => ({
          read: (references: ReadonlyArray<string>) =>
            Deferred.await(gate).pipe(Effect.andThen(client.read(references))),
        })),
      ),
  };

  const vault = withPasswordManager(store, state, vendor);

  await vault.run.runPromise(
    vault.service.save(agentId, "ACME_TOKEN", {
      hosts: ["api.acme.com", "old.acme.com"],
      value: "stored",
    }),
  );

  const saving = vault.run.runFork(
    vault.service.save(agentId, "ACME_TOKEN", { reference: reference() }),
  );

  await Effect.runPromise(Effect.yieldNow);
  await vault.run.runPromise(
    vault.service.save(agentId, "ACME_TOKEN", { hosts: ["api.acme.com"] }),
  );
  Effect.runSync(Deferred.succeed(gate, undefined));
  await Effect.runPromise(Fiber.join(saving));

  expect(store.run(vault.service.list(agentId)).credentials).toMatchObject([
    { hosts: ["api.acme.com"], reference: REFERENCE },
  ]);
  vault.close();
});

test("a credential shows the read error of its newest use", async () => {
  const { store, agentId } = open();
  const service = credentials(store);

  await store.runtime.runPromise(
    service.save(agentId, "ACME_TOKEN", {
      hosts: ["api.acme.com"],
      value: "secret",
    }),
  );

  const use = (at: string, error: string | null) =>
    store.run(
      service.recordUse(agentId, "ACME_TOKEN", {
        at,
        method: "GET",
        host: "api.acme.com",
        path: "/",
        status: error ? null : 200,
        error,
      }),
    );

  const lastError = () =>
    store.run(service.list(agentId)).credentials[0]?.lastError;

  expect(lastError()).toBeNull();
  use("2026-10-29T10:00:00.000Z", "Fake could not be reached");
  expect(lastError()).toBe("Fake could not be reached");
  use("2026-10-29T10:01:00.000Z", null);
  expect(lastError()).toBeNull();
  store.close();
});
