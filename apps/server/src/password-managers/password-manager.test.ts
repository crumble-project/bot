import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber, Option, Redacted, Result, Scope } from "effect";
import { TestClock } from "effect/testing";
import { bitwarden } from "./bitwarden";
import { onePassword } from "./one-password";
import {
  FAKE_TOKEN,
  fakePasswordManager,
  fakeVendor,
} from "../../test/support/fake-password-manager";
import {
  PasswordManagers,
  type PasswordManagerVendor,
} from "./password-manager";

const failureTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Option.getOrUndefined(
    Option.map(Exit.findErrorOption(exit), (error) => error._tag),
  );

const run = <A, E>(
  vendor: PasswordManagerVendor,
  effect: Effect.Effect<A, E, PasswordManagers | Scope.Scope>,
) =>
  Effect.runPromiseExit(
    Effect.scoped(effect).pipe(
      Effect.provide(PasswordManagers.layer([vendor])),
    ),
  );

const connect = PasswordManagers.use((managers) =>
  managers.connect("1password", Redacted.make(FAKE_TOKEN)),
);

describe("PasswordManagers", () => {
  test("reads each reference, failing only the ones that are gone", async () => {
    const exit = await run(
      fakeVendor(fakePasswordManager({ "op://v/i/password": "hunter2" })),
      Effect.gen(function* () {
        const client = yield* connect;

        return yield* client.read(["op://v/i/password", "op://v/gone/field"]);
      }),
    );

    if (!Exit.isSuccess(exit)) throw new Error("read failed");

    const read = exit.value.get("op://v/i/password")!;
    const gone = exit.value.get("op://v/gone/field")!;

    expect(Result.isSuccess(read) && Redacted.value(read.success)).toBe(
      "hunter2",
    );
    expect(Result.isFailure(gone) && gone.failure._tag).toBe(
      "SecretUnreadable",
    );
  });

  test("rejects a token the password manager refuses", async () => {
    const exit = await run(
      fakeVendor(fakePasswordManager()),
      PasswordManagers.use((managers) =>
        managers.connect("1password", Redacted.make("wrong")),
      ),
    );

    expect(failureTag(exit)).toBe("PasswordManagerTokenRejected");
  });

  test("a read that hangs fails as unreachable after the timeout", async () => {
    const exit = await run(
      fakeVendor({ ...fakePasswordManager(), mode: "hang" }),
      Effect.gen(function* () {
        const client = yield* connect;
        const reading = yield* Effect.forkChild(client.read(["op://v/i/f"]));

        yield* TestClock.adjust("10 seconds");

        return yield* Fiber.join(reading);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(failureTag(exit)).toBe("PasswordManagerUnreachable");
  });

  test("a read after the scope closes fails as disconnected", async () => {
    const exit = await run(
      fakeVendor(fakePasswordManager({ "op://v/i/password": "hunter2" })),
      Effect.gen(function* () {
        const client = yield* Effect.scoped(connect);

        return yield* client.read(["op://v/i/password"]);
      }),
    );

    expect(failureTag(exit)).toBe("PasswordManagerDisconnected");
  });

  test("closing the scope interrupts a read in flight", async () => {
    const probe = { ...fakePasswordManager(), mode: "hang" as const };

    const exit = await run(
      fakeVendor(probe),
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const client = yield* connect.pipe(Scope.provide(scope));
        const reading = yield* Effect.forkChild(client.read(["op://v/i/f"]));

        yield* Effect.yieldNow;
        yield* Scope.close(scope, Exit.void);

        return yield* Fiber.join(reading);
      }),
    );

    expect(failureTag(exit)).toBe("PasswordManagerDisconnected");
    expect(probe.interrupted).toBe(1);
  });

  test("interrupting a read interrupts the password manager's read", async () => {
    const probe = { ...fakePasswordManager(), mode: "hang" as const };

    await run(
      fakeVendor(probe),
      Effect.gen(function* () {
        const client = yield* connect;
        const reading = yield* Effect.forkChild(client.read(["op://v/i/f"]));

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(reading);
      }),
    );

    expect(probe.interrupted).toBe(1);
  });

  test("checks references against the password manager's format", async () => {
    const check = (vendor: PasswordManagerVendor, reference: string) =>
      run(
        vendor,
        PasswordManagers.use((managers) =>
          managers.checkReference(vendor.id, reference),
        ),
      ).then(Exit.isSuccess);

    expect(await check(onePassword, "op://Vault/Item/password")).toBe(true);
    expect(await check(onePassword, "op://Vault/password")).toBe(false);
    expect(await check(bitwarden, "6f1d2c3e-1b2a-4c5d-8e9f-0a1b2c3d4e5f")).toBe(
      true,
    );
    expect(await check(bitwarden, "op://Vault/Item/password")).toBe(false);
  });

  test("1Password rejects a malformed token without a request", async () => {
    const exit = await run(
      onePassword,
      PasswordManagers.use((managers) =>
        managers.connect("1password", Redacted.make("not-a-token")),
      ),
    );

    expect(failureTag(exit)).toBe("PasswordManagerTokenRejected");
  });
});
