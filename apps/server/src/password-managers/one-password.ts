import { ONE_PASSWORD_ITEM } from "../shared/domain";
import { errorText } from "../shared/errors";
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

// Seen in the SDK: a malformed token fails as "invalid user input" locally, a wrong one as "authentication error".
const rejectsToken = (cause: unknown) =>
  cause instanceof AuthExpiredError ||
  /invalid user input|authentication error/i.test(errorText(cause));

const failure = (cause: unknown) =>
  rejectsToken(cause)
    ? new PasswordManagerTokenRejected({
        message: `rejected the service account token: ${errorText(cause)}`,
      })
    : new PasswordManagerUnreachable({
        message:
          cause instanceof RateLimitExceededError
            ? `limited this account's requests: ${errorText(cause)}`
            : `could not be reached: ${errorText(cause)}`,
        cause,
      });

const reasons: Partial<Record<ResolveReferenceError["type"], string>> = {
  vaultNotFound: "has no vault the service account can read that matches",
  itemNotFound: "has no item that matches",
  fieldNotFound: "has no such field on the item",
  tooManyVaults: "has more than one vault that matches",
  tooManyItems: "has more than one item that matches",
  tooManyMatchingFields: "has more than one field that matches",
  parsing: "can't parse the reference",
};

// 1Password computes the current code for this attribute; any other one-time code source holds the TOTP secret.
const COMPUTED_CODE = "?attribute=totp";

/** 1Password, read with a service account token through `@1password/sdk`. */
export const onePassword: PasswordManagerVendor = {
  id: "1password",
  name: NAME,
  reference: Schema.String.check(
    Schema.isPattern(new RegExp(`^${ONE_PASSWORD_ITEM}/.+$`)),
  ),
  itemFields: (item) => ({
    username: `${item}/username`,
    password: `${item}/password`,
    one_time_code: `${item}/one-time password${COMPUTED_CODE}`,
  }),
  isVolatile: (reference) => reference.endsWith(COMPUTED_CODE),
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
                          ...(type === "fieldNotFound" && {
                            kind: "missing-field" as const,
                          }),
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
