import { asc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Redacted } from "effect";
import type {
  PasswordManagerId,
  SecretReference,
  SecretStatus,
} from "../contract/secrets";
import type { SecretSource } from "./secret-values";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { secrets } from "./schema";

/** A row of the `secrets` table. */
type SecretSourceRow = {
  value: string | null;
  passwordManager: PasswordManagerId | null;
  reference: string | null;
};

/** The row's source, decrypting a stored value; the database allows exactly one of the two. */
const secretSourceOf = (
  box: SecretBox["Service"],
  row: SecretSourceRow,
): SecretSource => {
  if (row.value !== null)
    return { stored: Redacted.make(box.decrypt(row.value)) };

  if (row.passwordManager === null || row.reference === null)
    throw new Error("A secret has neither a stored value nor a reference");

  return { passwordManager: row.passwordManager, reference: row.reference };
};

/** Encrypted values by key, such as an MCP server's token. */
export class SecretRepository extends Context.Service<
  SecretRepository,
  {
    readonly set: (key: string, value: string) => Effect.Effect<void>;
    /** Reads the value from a password manager, replacing one stored in Crumble. */
    readonly setReference: (
      key: string,
      source: SecretReference,
    ) => Effect.Effect<void>;
    /** A value stored in Crumble; reading one that comes from a password manager is a defect. */
    readonly get: (key: string) => Effect.Effect<string | undefined>;
    /** Where the value comes from: stored in Crumble, or a password manager reference. */
    readonly source: (key: string) => Effect.Effect<SecretSource | undefined>;
    /** Whether the key has a secret and where it comes from, read without decrypting anything. */
    readonly status: (key: string) => Effect.Effect<SecretStatus>;
    /** The keys of the secrets that read their value from a password manager. */
    readonly usedBy: (id: PasswordManagerId) => Effect.Effect<string[]>;
    readonly delete: (key: string) => Effect.Effect<boolean>;
    /** Deletes every key that starts with `prefix` and returns where their values came from. */
    readonly deleteAll: (prefix: string) => Effect.Effect<SecretSource[]>;
  }
>()("crumble/secrets/SecretRepository") {
  static readonly layer = Layer.effect(
    SecretRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const box = yield* SecretBox;

      const set = Effect.fn("SecretRepository.set")(function* (
        key: string,
        value: string,
      ) {
        // Saving a value in Crumble replaces a password manager reference.
        const row = {
          value: box.encrypt(value),
          passwordManager: null,
          reference: null,
        };

        yield* db
          .insert(secrets)
          .values({ key, ...row })
          .onConflictDoUpdate({ target: secrets.key, set: row });
      }, Effect.orDie);

      const setReference = Effect.fn("SecretRepository.setReference")(
        function* (key: string, source: SecretReference) {
          const row = {
            value: null,
            passwordManager: source.passwordManager,
            reference: source.reference,
          };

          yield* db
            .insert(secrets)
            .values({ key, ...row })
            .onConflictDoUpdate({ target: secrets.key, set: row });
        },
        Effect.orDie,
      );

      const get = Effect.fn("SecretRepository.get")(function* (key: string) {
        const [row] = yield* db
          .select({ value: secrets.value })
          .from(secrets)
          .where(eq(secrets.key, key));

        return row ? box.decryptStored(row.value) : undefined;
      }, Effect.orDie);

      const source = Effect.fn("SecretRepository.source")(function* (
        key: string,
      ) {
        const [row] = yield* db
          .select({
            value: secrets.value,
            passwordManager: secrets.passwordManager,
            reference: secrets.reference,
          })
          .from(secrets)
          .where(eq(secrets.key, key));

        return row && secretSourceOf(box, row);
      }, Effect.orDie);

      const status = Effect.fn("SecretRepository.status")(function* (
        key: string,
      ) {
        const [row] = yield* db
          .select({
            passwordManager: secrets.passwordManager,
            reference: secrets.reference,
          })
          .from(secrets)
          .where(eq(secrets.key, key));

        return {
          configured: row !== undefined,
          passwordManager: row?.passwordManager ?? null,
          reference: row?.reference ?? null,
        };
      }, Effect.orDie);

      const usedBy = Effect.fn("SecretRepository.usedBy")(function* (
        id: PasswordManagerId,
      ) {
        const rows = yield* db
          .select({ key: secrets.key })
          .from(secrets)
          .where(eq(secrets.passwordManager, id))
          .orderBy(asc(secrets.key));

        return rows.map((row) => row.key);
      }, Effect.orDie);

      const remove = Effect.fn("SecretRepository.delete")(function* (
        key: string,
      ) {
        const deleted = yield* db
          .delete(secrets)
          .where(eq(secrets.key, key))
          .returning({ key: secrets.key });

        return deleted.length > 0;
      }, Effect.orDie);

      const deleteAll = Effect.fn("SecretRepository.deleteAll")(function* (
        prefix: string,
      ) {
        // substr, not LIKE: keys may hold % and _.
        const deleted = yield* db
          .delete(secrets)
          .where(sql`substr(${secrets.key}, 1, ${prefix.length}) = ${prefix}`)
          .returning({
            value: secrets.value,
            passwordManager: secrets.passwordManager,
            reference: secrets.reference,
          });

        return deleted.map((row) => secretSourceOf(box, row));
      }, Effect.orDie);

      return SecretRepository.of({
        set,
        setReference,
        get,
        source,
        status,
        usedBy,
        delete: remove,
        deleteAll,
      });
    }),
  );
}
