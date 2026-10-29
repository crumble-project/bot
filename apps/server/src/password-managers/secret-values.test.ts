import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber, Layer, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import {
  FAKE_TOKEN,
  fakePasswordManager,
  fakeVendor,
  type FakePasswordManager,
} from "../../test/support/fake-password-manager";
import { PasswordManagers } from "./password-manager";
import { PasswordManagerRepository } from "./password-manager-repository";
import { SecretValues } from "./secret-values";

const REFERENCE = "op://v/i/password";
const source = { passwordManager: "1password", reference: REFERENCE } as const;

/** Runs `effect` with SecretValues over the fake, on a test clock. */
const run = <A, E>(
  state: FakePasswordManager,
  effect: Effect.Effect<A, E, SecretValues>,
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

  return Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(
        SecretValues.layer.pipe(
          Layer.provide(PasswordManagers.layer([fakeVendor(state)])),
          Layer.provide(repository),
        ),
      ),
      Effect.provide(TestClock.layer()),
    ),
  );
};

const read = SecretValues.use((values) => values.read(source)).pipe(
  Effect.map(Redacted.value),
);

const valueOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (!Exit.isSuccess(exit)) throw new Error(`read failed: ${String(exit)}`);

  return exit.value;
};

const failureOf = (exit: Exit.Exit<unknown, { readonly message: string }>) =>
  Option.getOrUndefined(
    Option.map(Exit.findErrorOption(exit), (error) => error.message),
  );

/** Lets a background refresh run to its end. */
const settle = Effect.repeat(Effect.yieldNow, { times: 20 });

describe("SecretValues", () => {
  test("a stored value needs no password manager", async () => {
    const state = fakePasswordManager();

    const exit = await run(
      state,
      SecretValues.use((values) =>
        values.read({ stored: Redacted.make("kept") }),
      ).pipe(Effect.map(Redacted.value)),
    );

    expect(valueOf(exit)).toBe("kept");
    expect(state.signIns).toBe(0);
  });

  test("reads once, then serves the cached value within the hour", async () => {
    const state = fakePasswordManager({ [REFERENCE]: "hunter2" });

    const exit = await run(
      state,
      Effect.gen(function* () {
        const first = yield* read;

        yield* TestClock.adjust("30 minutes");

        return [first, yield* read];
      }),
    );

    expect(valueOf(exit)).toEqual(["hunter2", "hunter2"]);
    expect(state.reads).toBe(1);
  });

  test("near the hour, serves the cached value and refreshes it in the background", async () => {
    const state = fakePasswordManager({ [REFERENCE]: "old" });

    const exit = await run(
      state,
      Effect.gen(function* () {
        yield* read;
        state.values.set(REFERENCE, "new");
        yield* TestClock.adjust("56 minutes");

        const during = yield* read;

        yield* settle;

        return [during, yield* read];
      }),
    );

    expect(valueOf(exit)).toEqual(["old", "new"]);
    expect(state.reads).toBe(2);
  });

  test("keeps a value for two hours while the password manager is unreachable, then fails", async () => {
    const state = fakePasswordManager({ [REFERENCE]: "hunter2" });

    const exit = await run(
      state,
      Effect.gen(function* () {
        yield* read;
        state.mode = "unreachable";
        yield* TestClock.adjust("90 minutes");

        const stale = yield* read;

        yield* TestClock.adjust("31 minutes");

        return [stale, yield* Effect.exit(read)] as const;
      }),
    );

    const [stale, expired] = valueOf(exit);

    expect(stale).toBe("hunter2");
    expect(failureOf(expired)).toBe("Fake could not be reached");
  });

  test("stops using a value at once when its item is gone", async () => {
    const state = fakePasswordManager({ [REFERENCE]: "hunter2" });

    const exit = await run(
      state,
      Effect.gen(function* () {
        yield* read;
        state.values.delete(REFERENCE);
        yield* TestClock.adjust("56 minutes");
        // The background refresh finds the item gone and drops the value.
        yield* read;
        yield* settle;

        return yield* Effect.exit(read);
      }),
    );

    expect(failureOf(valueOf(exit))).toBe("Fake has no item that matches");
  });

  test("forget makes the next read ask the password manager", async () => {
    const state = fakePasswordManager({ [REFERENCE]: "old" });

    const exit = await run(
      state,
      Effect.gen(function* () {
        yield* read;
        state.values.set(REFERENCE, "new");
        yield* SecretValues.use((values) =>
          values.forget("1password", REFERENCE),
        );

        return yield* read;
      }),
    );

    expect(valueOf(exit)).toBe("new");
  });

  test("disconnect interrupts a read in flight and signs in again afterwards", async () => {
    const state = fakePasswordManager({ [REFERENCE]: "hunter2" });

    const exit = await run(
      state,
      Effect.gen(function* () {
        state.mode = "hang";

        const reading = yield* Effect.forkChild(Effect.exit(read));

        yield* settle;
        yield* SecretValues.use((values) => values.disconnect("1password"));

        const interrupted = yield* Fiber.join(reading);

        state.mode = "answer";

        return [interrupted, yield* read] as const;
      }),
    );

    const [interrupted, after] = valueOf(exit);

    expect(failureOf(interrupted)).toBe("Fake was disconnected");
    expect(after).toBe("hunter2");
    expect(state.interrupted).toBe(1);
    expect(state.signIns).toBe(2);
  });

  test("a failed sign-in isn't kept: the next read signs in again", async () => {
    const state = fakePasswordManager({ [REFERENCE]: "hunter2" });
    let token = "wrong";

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const rejected = yield* Effect.exit(read);

        token = FAKE_TOKEN;

        return [rejected, yield* read] as const;
      }).pipe(
        Effect.provide(
          SecretValues.layer.pipe(
            Layer.provide(PasswordManagers.layer([fakeVendor(state)])),
            Layer.provide(
              Layer.succeed(
                PasswordManagerRepository,
                PasswordManagerRepository.of({
                  list: Effect.succeed([]),
                  token: () => Effect.sync(() => Redacted.make(token)),
                  save: () => Effect.void,
                  usedBy: () => Effect.succeed([]),
                  delete: () => Effect.succeed(true),
                }),
              ),
            ),
          ),
        ),
      ),
    );

    const [rejected, after] = valueOf(exit);

    expect(failureOf(rejected)).toBe("Fake rejected");
    expect(after).toBe("hunter2");
  });

  test("a password manager that isn't connected fails the read", async () => {
    const exit = await run(fakePasswordManager(), read, { connected: false });

    expect(failureOf(exit)).toBe("Fake isn't connected");
  });
});
