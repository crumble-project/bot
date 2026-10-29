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
        message: `${NAME} rejected the service account token: ${messageOf(cause)}`,
      })
    : new PasswordManagerUnreachable({
        message:
          cause instanceof RateLimitExceededError
            ? `${NAME} limited this account's requests: ${messageOf(cause)}`
            : `${NAME} could not be reached: ${messageOf(cause)}`,
        cause,
      });

const reasons: Partial<Record<ResolveReferenceError["type"], string>> = {
  vaultNotFound: "no vault the service account can read matches",
  itemNotFound: "no item matches",
  fieldNotFound: "the item has no such field",
  tooManyVaults: "more than one vault matches",
  tooManyItems: "more than one item matches",
  tooManyMatchingFields: "more than one field matches",
  parsing: "the reference isn't valid",
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
                          message: `${NAME} could not read ${reference}: ${reasons[type] ?? type}`,
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
