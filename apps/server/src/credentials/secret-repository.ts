import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { SecretReference } from "../password-managers/secret-references";
import {
  secretSourceOf,
  type SecretSource,
} from "../password-managers/secret-values";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { secrets } from "./schema";

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
    readonly delete: (key: string) => Effect.Effect<boolean>;
    readonly listKeys: Effect.Effect<string[]>;
  }
>()("crumble/credentials/SecretRepository") {
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

      const remove = Effect.fn("SecretRepository.delete")(function* (
        key: string,
      ) {
        const deleted = yield* db
          .delete(secrets)
          .where(eq(secrets.key, key))
          .returning({ key: secrets.key });

        return deleted.length > 0;
      }, Effect.orDie);

      const listKeys = db
        .select({ key: secrets.key })
        .from(secrets)
        .orderBy(asc(secrets.key))
        .pipe(
          Effect.map((rows) => rows.map((row) => row.key)),
          Effect.orDie,
          Effect.withSpan("SecretRepository.listKeys"),
        );

      return SecretRepository.of({
        set,
        setReference,
        get,
        source,
        delete: remove,
        listKeys,
      });
    }),
  );
}
