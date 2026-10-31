import { Effect, Redacted } from "effect";
import type { SecretReference } from "../shared/domain";
import { InvalidInput } from "../shared/errors";
import { PasswordManagers } from "./password-manager";
import type { SecretRepository } from "../credentials/secret-repository";
import { SecretValues } from "./secret-values";

/** Fails with `InvalidInput` unless the reference has its password manager's format and can be read now, whatever is cached. */
export const checkSecretReference = Effect.fnUntraced(function* (
  source: SecretReference,
) {
  const managers = yield* PasswordManagers;

  yield* managers.checkReference(source.passwordManager, source.reference);
  yield* SecretValues.use((values) => values.readNow(source)).pipe(
    Effect.mapError((error) => new InvalidInput({ message: error.message })),
  );
});

/** Reads a keyed secret's value, from its password manager when it holds a reference; undefined when it has none. */
export const keyedSecretReader =
  (secrets: SecretRepository["Service"], values: SecretValues["Service"]) =>
  (key: string) =>
    secrets
      .source(key)
      .pipe(
        Effect.flatMap((source) =>
          source
            ? values.read(source).pipe(Effect.map(Redacted.value))
            : Effect.succeed(undefined),
        ),
      );
