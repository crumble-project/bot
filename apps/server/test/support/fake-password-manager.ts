import { Effect, Redacted, Result, Schema } from "effect";
import { PasswordManagerRepository } from "../../src/password-managers/password-manager-repository";
import {
  PasswordManagerTokenRejected,
  PasswordManagerUnreachable,
  SecretUnreadable,
  type PasswordManagerVendor,
} from "../../src/password-managers/password-manager";
import { onePassword } from "../../src/password-managers/one-password";

export const FAKE_TOKEN = "fake-token";

/** Connects the fake as 1Password, so references to it read. */
export const connectFakePasswordManager = PasswordManagerRepository.use(
  (repository) => repository.save("1password", Redacted.make(FAKE_TOKEN), "t"),
);

/** What the fake password manager holds and how it answers; tests change it between reads. */
export type FakePasswordManager = {
  values: Map<string, string>;
  /** References that fail with this reason, as one 1Password can't resolve. */
  unreadable: Map<string, string>;
  /** `hang` never answers, so only a timeout or an interruption ends the read. */
  mode: "answer" | "unreachable" | "hang";
  /** When set, a read answers only after it resolves, so a test can act while the read is in flight. */
  held?: Promise<void>;
  signIns: number;
  reads: number;
  interrupted: number;
};

export const fakePasswordManager = (
  values: Record<string, string> = {},
): FakePasswordManager => ({
  values: new Map(Object.entries(values)),
  unreadable: new Map(),
  mode: "answer",
  signIns: 0,
  reads: 0,
  interrupted: 0,
});

const itemOf = (reference: string) =>
  reference.split("/").slice(0, 4).join("/");

/** As 1Password answers: a missing field on an item it holds, otherwise no such item. */
const missing = (state: FakePasswordManager, reference: string) => {
  const reason = state.unreadable.get(reference);

  if (reason) return { message: reason };

  return [...state.values.keys()].some(
    (held) => itemOf(held) === itemOf(reference),
  )
    ? {
        message: "has no such field on the item",
        kind: "missing-field" as const,
      }
    : { message: "has no item that matches" };
};

/** A 1Password stand-in over `state` that accepts only `FAKE_TOKEN`. */
export const fakeVendor = (
  state: FakePasswordManager,
): PasswordManagerVendor => ({
  id: "1password",
  name: "Fake",
  reference: Schema.String,
  itemFields: onePassword.itemFields!,
  isVolatile: onePassword.isVolatile!,
  signIn: (token) =>
    Effect.suspend(() => {
      if (Redacted.value(token) !== FAKE_TOKEN)
        return Effect.fail(
          new PasswordManagerTokenRejected({ message: "rejected" }),
        );

      state.signIns++;

      return Effect.succeed({
        read: (references: ReadonlyArray<string>) =>
          Effect.suspend(() => {
            state.reads++;

            if (state.mode === "hang")
              return Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    state.interrupted++;
                  }),
                ),
              );

            if (state.mode === "unreachable")
              return Effect.fail(
                new PasswordManagerUnreachable({
                  message: "could not be reached",
                  cause: undefined,
                }),
              );

            const held = state.held;

            return Effect.promise(() => held ?? Promise.resolve()).pipe(
              Effect.map(
                () =>
                  new Map(
                    references.map((reference) => {
                      const value = state.values.get(reference);

                      return [
                        reference,
                        value === undefined || state.unreadable.has(reference)
                          ? Result.fail(
                              new SecretUnreadable({
                                reference,
                                ...missing(state, reference),
                              }),
                            )
                          : Result.succeed(Redacted.make(value)),
                      ];
                    }),
                  ),
              ),
            );
          }),
      });
    }),
});
