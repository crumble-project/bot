import { expect, test } from "bun:test";
import { Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import {
  FAKE_TOKEN,
  fakePasswordManager,
  fakeVendor,
  type FakePasswordManager,
} from "../../test/support/fake-password-manager";
import { SecretRepository } from "./secret-repository";
import { InvalidInput } from "../shared/errors";
import type { SecretReference } from "../contract/secrets";
import { PasswordManagers } from "../password-managers/password-manager";
import { PasswordManagerRepository } from "../password-managers/password-manager-repository";
import { SecretValues, type SecretSource } from "./secret-values";
import { Secrets } from "./secrets";
import { botSecretsPrefix } from "./secret-key";

const REFERENCE = "op://Vault/Linear/token";

const memoryRepository = (rows = new Map<string, SecretSource>()) =>
  Layer.succeed(
    SecretRepository,
    SecretRepository.of({
      set: (key, value) =>
        Effect.sync(() => {
          rows.set(key, { stored: Redacted.make(value) });
        }),
      setReference: (key, source) =>
        Effect.sync(() => {
          rows.set(key, source);
        }),
      get: () => Effect.die("not used"),
      source: (key) => Effect.sync(() => rows.get(key)),
      status: (key) =>
        Effect.sync(() => {
          const row = rows.get(key);

          return row && "reference" in row
            ? { configured: true, ...row }
            : {
                configured: row !== undefined,
                passwordManager: null,
                reference: null,
              };
        }),
      usedBy: () => Effect.die("not used"),
      delete: (key) => Effect.sync(() => rows.delete(key)),
      deleteAll: (prefix) =>
        Effect.sync(() =>
          [...rows.keys()]
            .filter((key) => key.startsWith(prefix))
            .flatMap((key) => {
              const row = rows.get(key)!;
              rows.delete(key);

              return [row];
            }),
        ),
    }),
  );

const run = <A, E>(
  state: FakePasswordManager,
  effect: Effect.Effect<A, E, Secrets | SecretValues>,
  { connected = true, rows = new Map<string, SecretSource>() } = {},
) => {
  const repository = Layer.succeed(
    PasswordManagerRepository,
    PasswordManagerRepository.of({
      list: Effect.succeed([]),
      token: () =>
        Effect.succeed(connected ? Redacted.make(FAKE_TOKEN) : undefined),
      save: () => Effect.void,
      delete: () => Effect.succeed(true),
    }),
  );

  const vendor = {
    ...fakeVendor(state),
    reference: Schema.String.check(Schema.isPattern(/^op:\/\//)),
  };

  return Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(
        Secrets.layer.pipe(
          Layer.provideMerge(SecretValues.layer),
          Layer.provide(PasswordManagers.layer([vendor])),
          Layer.provide(repository),
          Layer.provide(memoryRepository(rows)),
        ),
      ),
    ),
  );
};

const read = (source: SecretReference) =>
  SecretValues.use((values) => values.read(source));

const KEY = "mcp:server";

const check = (
  state: FakePasswordManager,
  source: SecretReference,
  options?: { connected?: boolean },
) =>
  run(
    state,
    Secrets.use((secrets) =>
      secrets
        .save(KEY, { reference: source })
        .pipe(Effect.andThen(secrets.read(KEY))),
    ),
    options,
  );

const save = (source: SecretReference) =>
  Secrets.use((secrets) => secrets.save(KEY, { reference: source }));

const failureOf = (exit: Exit.Exit<unknown, { readonly message: string }>) =>
  Option.getOrUndefined(
    Option.map(Exit.findErrorOption(exit), (error) => error.message),
  );

const source = (reference: string): SecretReference => ({
  passwordManager: "1password",
  reference,
});

test("a malformed reference fails with the format message and reads nothing", async () => {
  const state = fakePasswordManager();

  expect(failureOf(await check(state, source("Vault/Linear")))).toBe(
    "Not a Fake reference: Vault/Linear",
  );
  expect(state.reads).toBe(0);
});

test("a reference to a missing item fails with the password manager's message", async () => {
  expect(failureOf(await check(fakePasswordManager(), source(REFERENCE)))).toBe(
    "Fake has no item that matches",
  );
});

test("a reference to a password manager that isn't connected fails", async () => {
  expect(
    failureOf(
      await check(fakePasswordManager(), source(REFERENCE), {
        connected: false,
      }),
    ),
  ).toBe("Fake isn't connected");
});

test("a readable reference passes and leaves its value cached", async () => {
  const state = fakePasswordManager({ [REFERENCE]: "lin_value" });
  const exit = await check(state, source(REFERENCE));

  expect(Exit.isSuccess(exit) && exit.value && Redacted.value(exit.value)).toBe(
    "lin_value",
  );
  expect(state.reads).toBe(1);
});

test("a cached value doesn't pass the check while the password manager is unreachable", async () => {
  const state = fakePasswordManager({ [REFERENCE]: "lin_value" });

  const exit = await run(
    state,
    read(source(REFERENCE)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          state.mode = "unreachable";
        }),
      ),
      Effect.andThen(save(source(REFERENCE))),
    ),
  );

  expect(failureOf(exit)).toBe("Fake could not be reached");
  expect(state.reads).toBe(2);
});

test("a cached value doesn't pass the check once its item is gone", async () => {
  const state = fakePasswordManager({ [REFERENCE]: "lin_value" });

  const exit = await run(
    state,
    read(source(REFERENCE)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          state.values.clear();
        }),
      ),
      Effect.andThen(save(source(REFERENCE))),
    ),
  );

  expect(failureOf(exit)).toBe("Fake has no item that matches");
});

test("a value `verify` refuses isn't stored", async () => {
  const rows = new Map<string, SecretSource>();

  const exit = await run(
    fakePasswordManager(),
    Secrets.use((secrets) =>
      secrets.save(KEY, { value: "ghp_wrong" }, () =>
        Effect.fail(new InvalidInput({ message: "GitHub refused it" })),
      ),
    ),
    { rows },
  );

  expect(failureOf(exit)).toBe("GitHub refused it");
  expect(rows.size).toBe(0);
});

test("saveAll stores nothing when one entry can't be read", async () => {
  const rows = new Map<string, SecretSource>();

  const exit = await run(
    fakePasswordManager(),
    Secrets.use((secrets) =>
      secrets.saveAll([
        { key: "a", input: { value: "alice" } },
        { key: "b", input: { reference: source(REFERENCE) } },
      ]),
    ),
    { rows },
  );

  expect(failureOf(exit)).toBe("Fake has no item that matches");
  expect(rows.size).toBe(0);
});

test("replacing a reference drops its cached value", async () => {
  const state = fakePasswordManager({ [REFERENCE]: "lin_value" });

  const exit = await run(
    state,
    Secrets.use((secrets) =>
      save(source(REFERENCE)).pipe(
        Effect.andThen(secrets.save(KEY, { value: "stored" })),
        Effect.andThen(read(source(REFERENCE))),
      ),
    ),
  );

  expect(Exit.isSuccess(exit) && Redacted.value(exit.value)).toBe("lin_value");
  expect(state.reads).toBe(2);
});

test("a key prefix ends at a separator, so bot b1's doesn't cover bot b10", () => {
  expect(botSecretsPrefix("b1")).toBe("bot:b1:");
});

test("deleteAll drops the cached values of the references it deletes", async () => {
  const state = fakePasswordManager({ [REFERENCE]: "lin_value" });
  const bot = botSecretsPrefix("b1");

  await run(
    state,
    Secrets.use((secrets) =>
      secrets
        .save(`${bot}credential:A`, { reference: source(REFERENCE) })
        .pipe(
          Effect.andThen(secrets.deleteAll(bot)),
          Effect.andThen(read(source(REFERENCE))),
        ),
    ),
  );

  expect(state.reads).toBe(2);
});
