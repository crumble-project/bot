import { expect, test } from "bun:test";
import { Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import {
  FAKE_TOKEN,
  fakePasswordManager,
  fakeVendor,
  type FakePasswordManager,
} from "../../test/support/fake-password-manager";
import { SecretRepository } from "../credentials/secret-repository";
import { InvalidInput } from "../shared/errors";
import type { SecretReference } from "../shared/domain";
import { PasswordManagers } from "./password-manager";
import { PasswordManagerRepository } from "./password-manager-repository";
import { SecretValues, type SecretSource } from "./secret-values";
import { Secrets, secretKeyPrefix } from "./secrets";

const REFERENCE = "op://Vault/Linear/token";

/** The secrets table in memory, values unencrypted. */
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
      listKeys: Effect.sync(() => [...rows.keys()]),
    }),
  );

/** Runs `effect` over a fake whose references start with `op://`. */
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
      usedBy: () => Effect.succeed([]),
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

/** Saves `source` as a secret, then reads it again. */
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

  expect(Exit.isSuccess(exit)).toBe(true);
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

  expect(Exit.isSuccess(exit)).toBe(true);
  // Without the drop, the read would come from the cache the save filled.
  expect(state.reads).toBe(2);
});

test("deleteAll removes every secret under a prefix and nothing else", async () => {
  const rows = new Map<string, SecretSource>();
  const bot = secretKeyPrefix("bot", "b1");

  await run(
    fakePasswordManager(),
    Secrets.use((secrets) =>
      Effect.all([
        secrets.save(`${bot}credential:A`, { value: "1" }),
        secrets.save(`${bot}login:x:password`, { value: "2" }),
        secrets.save("bot:b10:credential:A", { value: "3" }),
      ]).pipe(Effect.andThen(secrets.deleteAll(bot))),
    ),
    { rows },
  );

  expect([...rows.keys()]).toEqual(["bot:b10:credential:A"]);
});
