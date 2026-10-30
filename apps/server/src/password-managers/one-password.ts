import {
  AuthExpiredError,
  createClient,
  RateLimitExceededError,
  type ResolveReferenceError,
} from "@1password/sdk";
import { Effect, Redacted, Result, Schema } from "effect";
import {
  PasswordManagerTokenRejected,
  PasswordManagerUnreachable,
  SecretUnreadable,
  type PasswordManagerVendor,
  type SecretRead,
} from "./password-manager";

const NAME = "1Password";

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

// Seen in the SDK: a malformed token fails as "invalid user input" locally, a wrong one as "authentication error".
const rejectsToken = (cause: unknown) =>
  cause instanceof AuthExpiredError ||
  /invalid user input|authentication error/i.test(messageOf(cause));

const failure = (cause: unknown) =>
  rejectsToken(cause)
    ? new PasswordManagerTokenRejected({
        message: `rejected the service account token: ${messageOf(cause)}`,
      })
    : new PasswordManagerUnreachable({
        message:
          cause instanceof RateLimitExceededError
            ? `limited this account's requests: ${messageOf(cause)}`
            : `could not be reached: ${messageOf(cause)}`,
        cause,
      });

/** The reason a 1Password item has no field with the reference's name. */
export const FIELD_NOT_FOUND = "has no such field on the item";

const reasons: Partial<Record<ResolveReferenceError["type"], string>> = {
  vaultNotFound: "has no vault the service account can read that matches",
  itemNotFound: "has no item that matches",
  fieldNotFound: FIELD_NOT_FOUND,
  tooManyVaults: "has more than one vault that matches",
  tooManyItems: "has more than one item that matches",
  tooManyMatchingFields: "has more than one field that matches",
  parsing: "can't parse the reference",
};

/** 1Password, read with a service account token through `@1password/sdk`. */
export const onePassword: PasswordManagerVendor = {
  id: "1password",
  name: NAME,
  reference: Schema.String.check(Schema.isPattern(/^op:\/\/[^/]+\/[^/]+\/.+$/)),
  signIn: (token) =>
    Effect.tryPromise({
      try: () =>
        createClient({
          auth: Redacted.value(token),
          integrationName: "Crumble",
          integrationVersion: "1",
        }),
      catch: failure,
    }).pipe(
      Effect.map((client) => ({
        // resolveAll reports a missing item per reference, where resolve only throws a message.
        read: (references) =>
          Effect.tryPromise({
            try: () => client.secrets.resolveAll([...references]),
            catch: failure,
          }).pipe(
            Effect.map(
              ({ individualResponses }) =>
                new Map(
                  references.map((reference): [string, SecretRead] => {
                    const response = individualResponses[reference];

                    if (response?.content)
                      return [
                        reference,
                        Result.succeed(Redacted.make(response.content.secret)),
                      ];

                    const type = response?.error?.type ?? "other";

                    return [
                      reference,
                      Result.fail(
                        new SecretUnreadable({
                          reference,
                          message:
                            reasons[type] ?? `could not read it: ${type}`,
                        }),
                      ),
                    ];
                  }),
                ),
            ),
          ),
      })),
    ),
};
