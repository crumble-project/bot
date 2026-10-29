import { Effect, Redacted, Result, Schema } from "effect";
import {
  PasswordManagerTokenRejected,
  PasswordManagerUnreachable,
  PasswordManagerUnsupported,
  SecretUnreadable,
  type PasswordManagerVendor,
  type SecretRead,
} from "./password-manager";

const NAME = "Bitwarden";

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

// The native SDK has no Linux arm64 build; importing it on first use keeps the server starting there.
const sdk = Effect.tryPromise({
  try: () => import("@bitwarden/sdk-napi"),
  catch: (cause) =>
    new PasswordManagerUnsupported({
      message: `isn't supported on ${process.platform} ${process.arch}: ${messageOf(cause)}`,
      cause,
    }),
});

/** Bitwarden Secrets Manager, read with a machine account's access token through `@bitwarden/sdk-napi`. */
export const bitwarden: PasswordManagerVendor = {
  id: "bitwarden",
  name: NAME,
  reference: Schema.String.check(Schema.isUUID()),
  signIn: (token) =>
    Effect.gen(function* () {
      const { BitwardenClient } = yield* sdk;
      const client = new BitwardenClient();

      // The SDK rejects a malformed token locally; the server's answer to a revoked one is UNKNOWN, so it reads as unreachable.
      yield* Effect.tryPromise({
        try: () => client.auth().loginAccessToken(Redacted.value(token)),
        catch: (cause) =>
          /access token/i.test(messageOf(cause))
            ? new PasswordManagerTokenRejected({
                message: `rejected the access token: ${messageOf(cause)}`,
              })
            : new PasswordManagerUnreachable({
                message: `could not be reached: ${messageOf(cause)}`,
                cause,
              }),
      });

      return {
        // Errors are untyped messages, and how a missing secret differs from a network failure is UNKNOWN.
        read: (references) =>
          Effect.tryPromise({
            try: () => client.secrets().getByIds([...references]),
            catch: (cause) =>
              new PasswordManagerUnreachable({
                message: `could not be reached: ${messageOf(cause)}`,
                cause,
              }),
          }).pipe(
            Effect.map(({ data }) => {
              // UUIDs match in any case, and the reference check accepts any case.
              const values = new Map(
                data.map((secret) => [secret.id.toLowerCase(), secret.value]),
              );

              return new Map(
                references.map((reference): [string, SecretRead] => {
                  const value = values.get(reference.toLowerCase());

                  return [
                    reference,
                    value === undefined
                      ? Result.fail(
                          new SecretUnreadable({
                            reference,
                            message:
                              "has no secret the machine account can read with this ID",
                          }),
                        )
                      : Result.succeed(Redacted.make(value)),
                  ];
                }),
              );
            }),
          ),
      };
    }),
};
