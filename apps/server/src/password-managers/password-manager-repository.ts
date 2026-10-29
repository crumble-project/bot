import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Redacted } from "effect";
import { agentCredentials, secrets } from "../credentials/schema";
import { providerCredentials } from "../providers/schema";
import { Conflict } from "../shared/errors";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import type { PasswordManagerId } from "./password-manager";
import { passwordManagers } from "./schema";

export type PasswordManagerConnection = {
  id: PasswordManagerId;
  connectedAt: string;
};

/** A secret that reads its value from a password manager. */
export type SecretUsingPasswordManager =
  | { kind: "botCredential"; agentId: string; name: string }
  | { kind: "providerCredential"; provider: string }
  | { kind: "secret"; key: string };

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
    readonly usedBy: (
      id: PasswordManagerId,
    ) => Effect.Effect<SecretUsingPasswordManager[]>;
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
        const bots = yield* db
          .select({
            agentId: agentCredentials.agentId,
            name: agentCredentials.name,
          })
          .from(agentCredentials)
          .where(eq(agentCredentials.passwordManager, id))
          .orderBy(asc(agentCredentials.agentId), asc(agentCredentials.name));

        const providers = yield* db
          .select({ provider: providerCredentials.provider })
          .from(providerCredentials)
          .where(eq(providerCredentials.passwordManager, id))
          .orderBy(asc(providerCredentials.provider));

        const keyed = yield* db
          .select({ key: secrets.key })
          .from(secrets)
          .where(eq(secrets.passwordManager, id))
          .orderBy(asc(secrets.key));

        return [
          ...bots.map((row): SecretUsingPasswordManager => ({
            kind: "botCredential",
            ...row,
          })),
          ...providers.map((row): SecretUsingPasswordManager => ({
            kind: "providerCredential",
            ...row,
          })),
          ...keyed.map((row): SecretUsingPasswordManager => ({
            kind: "secret",
            ...row,
          })),
        ];
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
