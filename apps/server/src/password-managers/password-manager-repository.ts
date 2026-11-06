import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Redacted } from "effect";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import type { PasswordManagerId } from "../contract/secrets";
import { passwordManagers } from "./schema";

export type PasswordManagerConnection = {
  id: PasswordManagerId;
  connectedAt: string;
};

export class PasswordManagerRepository extends Context.Service<
  PasswordManagerRepository,
  {
    /** Metadata only: listing never decrypts a token. */
    readonly list: Effect.Effect<PasswordManagerConnection[]>;
    readonly token: (
      id: PasswordManagerId,
    ) => Effect.Effect<Redacted.Redacted | undefined>;
    readonly save: (
      id: PasswordManagerId,
      token: Redacted.Redacted,
      connectedAt: string,
    ) => Effect.Effect<void>;
    /** The foreign key from `secrets` refuses this while a secret reads from it; check `SecretRepository.usedBy` first. */
    readonly delete: (id: PasswordManagerId) => Effect.Effect<boolean>;
  }
>()("crumble/password-managers/PasswordManagerRepository") {
  static readonly layer = Layer.effect(
    PasswordManagerRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const box = yield* SecretBox;

      const list = db
        .select({
          id: passwordManagers.id,
          connectedAt: passwordManagers.connectedAt,
        })
        .from(passwordManagers)
        .orderBy(asc(passwordManagers.id))
        .pipe(Effect.orDie, Effect.withSpan("PasswordManagerRepository.list"));

      const token = Effect.fn("PasswordManagerRepository.token")(function* (
        id: PasswordManagerId,
      ) {
        const [row] = yield* db
          .select({ token: passwordManagers.token })
          .from(passwordManagers)
          .where(eq(passwordManagers.id, id));

        return row ? Redacted.make(box.decrypt(row.token)) : undefined;
      }, Effect.orDie);

      const save = Effect.fn("PasswordManagerRepository.save")(function* (
        id: PasswordManagerId,
        value: Redacted.Redacted,
        connectedAt: string,
      ) {
        const encrypted = box.encrypt(Redacted.value(value));

        yield* db
          .insert(passwordManagers)
          .values({ id, token: encrypted, connectedAt })
          .onConflictDoUpdate({
            target: passwordManagers.id,
            set: { token: encrypted },
          });
      }, Effect.orDie);

      const remove = Effect.fn("PasswordManagerRepository.delete")(function* (
        id: PasswordManagerId,
      ) {
        const deleted = yield* db
          .delete(passwordManagers)
          .where(eq(passwordManagers.id, id))
          .returning({ id: passwordManagers.id });

        return deleted.length > 0;
      }, Effect.orDie);

      return PasswordManagerRepository.of({
        list,
        token,
        save,
        delete: remove,
      });
    }),
  );
}
