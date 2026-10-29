import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { secrets } from "./schema";

/** Encrypted values by key, such as an MCP server's token. */
export class SecretRepository extends Context.Service<
  SecretRepository,
  {
    readonly set: (key: string, value: string) => Effect.Effect<void>;
    readonly get: (key: string) => Effect.Effect<string | undefined>;
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
        const encrypted = box.encrypt(value);

        yield* db
          .insert(secrets)
          .values({ key, value: encrypted })
          .onConflictDoUpdate({
            target: secrets.key,
            set: { value: encrypted },
          });
      }, Effect.orDie);

      const get = Effect.fn("SecretRepository.get")(function* (key: string) {
        const [row] = yield* db
          .select({ value: secrets.value })
          .from(secrets)
          .where(eq(secrets.key, key));

        return row ? box.decryptStored(row.value) : undefined;
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

      return SecretRepository.of({ set, get, delete: remove, listKeys });
    }),
  );
}
