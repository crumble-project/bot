import { Effect } from "effect";
import { z } from "zod";
import { InvalidInput } from "../shared/errors";
import { PasswordManagers } from "./password-manager";
import { SecretValues } from "./secret-values";

export const passwordManagerIdInput = z.enum(["1password", "bitwarden"]);

/** Where to read a secret's value instead of storing it: a password manager and a reference it understands. */
export const secretReferenceInput = z.object({
  passwordManager: passwordManagerIdInput,
  reference: z.string().trim().min(1).max(1000),
});

export type SecretReference = z.infer<typeof secretReferenceInput>;

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
