import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Redacted } from "effect";
import { secrets } from "../credentials/schema";
import { Conflict } from "../shared/errors";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import type { PasswordManagerId } from "../shared/domain";
import { passwordManagers } from "./schema";

export type PasswordManagerConnection = {
  id: PasswordManagerId;
  connectedAt: string;
};

/** The account's password manager connections, with their tokens encrypted at rest. */
export class PasswordManagerRepository extends Context.Service<
  PasswordManagerRepository,
  {
    /** Metadata only: listing never decrypts a token. */
    readonly list: Effect.Effect<PasswordManagerConnection[]>;
    readonly token: (
      id: PasswordManagerId,
    ) => Effect.Effect<Redacted.Redacted | undefined>;
    /** Connects the password manager, or replaces its token. */
    readonly save: (
      id: PasswordManagerId,
      token: Redacted.Redacted,
      connectedAt: string,
    ) => Effect.Effect<void>;
    /** The keys of the secrets that read their value from it. */
    readonly usedBy: (id: PasswordManagerId) => Effect.Effect<string[]>;
    /** Fails with `Conflict` while any secret still reads from the password manager. */
    readonly delete: (
      id: PasswordManagerId,
    ) => Effect.Effect<boolean, Conflict>;
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

      const usedBy = Effect.fn("PasswordManagerRepository.usedBy")(function* (
        id: PasswordManagerId,
      ) {
        const rows = yield* db
          .select({ key: secrets.key })
          .from(secrets)
          .where(eq(secrets.passwordManager, id))
          .orderBy(asc(secrets.key));

        return rows.map((row) => row.key);
      }, Effect.orDie);

      const remove = Effect.fn("PasswordManagerRepository.delete")(function* (
        id: PasswordManagerId,
      ) {
        const using = yield* usedBy(id);

        if (using.length > 0)
          return yield* new Conflict({
            message: `${using.length} secret${using.length === 1 ? "" : "s"} still read from this password manager`,
          });

        const deleted = yield* db
          .delete(passwordManagers)
          .where(eq(passwordManagers.id, id))
          .returning({ id: passwordManagers.id })
          .pipe(Effect.orDie);

        return deleted.length > 0;
      });

      return PasswordManagerRepository.of({
        list,
        token,
        save,
        usedBy,
        delete: remove,
      });
    }),
  );
}
