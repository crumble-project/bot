import { Effect, Redacted, Result, Schema } from "effect";
import {
  PasswordManagerTokenRejected,
  PasswordManagerUnreachable,
  SecretUnreadable,
  type PasswordManagerVendor,
} from "../../src/password-managers/password-manager";

export const FAKE_TOKEN = "fake-token";

/** What the fake password manager holds and how it answers; tests change it between reads. */
export type FakePasswordManager = {
  values: Map<string, string>;
  /** `hang` never answers, so only a timeout or an interruption ends the read. */
  mode: "answer" | "unreachable" | "hang";
  signIns: number;
  reads: number;
  interrupted: number;
};

export const fakePasswordManager = (
  values: Record<string, string> = {},
): FakePasswordManager => ({
  values: new Map(Object.entries(values)),
  mode: "answer",
  signIns: 0,
  reads: 0,
  interrupted: 0,
});

/** A 1Password stand-in over `state` that accepts only `FAKE_TOKEN`. */
export const fakeVendor = (
  state: FakePasswordManager,
): PasswordManagerVendor => ({
  id: "1password",
  name: "Fake",
  reference: Schema.String,
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
                  message: "Fake could not be reached",
                  cause: undefined,
                }),
              );

            return Effect.succeed(
              new Map(
                references.map((reference) => {
                  const value = state.values.get(reference);

                  return [
                    reference,
                    value === undefined
                      ? Result.fail(
                          new SecretUnreadable({
                            reference,
                            message: "no item matches",
                          }),
                        )
                      : Result.succeed(Redacted.make(value)),
                  ];
                }),
              ),
            );
          }),
      });
    }),
});
