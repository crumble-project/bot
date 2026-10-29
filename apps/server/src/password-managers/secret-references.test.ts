import { expect, test } from "bun:test";
import { Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import {
  FAKE_TOKEN,
  fakePasswordManager,
  fakeVendor,
  type FakePasswordManager,
} from "../../test/support/fake-password-manager";
import { PasswordManagers } from "./password-manager";
import { PasswordManagerRepository } from "./password-manager-repository";
import { checkSecretReference } from "./secret-references";
import type { SecretReference } from "../shared/domain";
import { SecretValues } from "./secret-values";

const REFERENCE = "op://Vault/Linear/token";

/** Runs `effect` over a fake whose references start with `op://`. */
const run = <A, E>(
  state: FakePasswordManager,
  effect: Effect.Effect<A, E, PasswordManagers | SecretValues>,
  { connected = true } = {},
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
        SecretValues.layer.pipe(
          Layer.provideMerge(PasswordManagers.layer([vendor])),
          Layer.provide(repository),
        ),
      ),
    ),
  );
};

const read = (source: SecretReference) =>
  SecretValues.use((values) => values.read(source));

/** Checks `source`, then reads it again. */
const check = (
  state: FakePasswordManager,
  source: SecretReference,
  options?: { connected?: boolean },
) =>
  run(
    state,
    checkSecretReference(source).pipe(Effect.andThen(read(source))),
    options,
  );

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
      Effect.andThen(checkSecretReference(source(REFERENCE))),
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
      Effect.andThen(checkSecretReference(source(REFERENCE))),
    ),
  );

  expect(failureOf(exit)).toBe("Fake has no item that matches");
});
