import { and, asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { parseHosts } from "../bot-secrets/schema";
import { botSecretKey, botSecretsPrefix } from "../secrets/secret-key";
import { lastUseError } from "../bot-secrets/bot-secret-uses";
import type { LoginField, SecretStatus } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { logins } from "./schema";

/** A login the owner gave one bot for its desktop jobs. Values are write-only and never part of this record. */
export type Login = {
  name: string;
  hosts: string[];
  fields: Partial<Record<LoginField, SecretStatus>>;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** Why the newest fill couldn't read its value; null when it could. */
  lastError: string | null;
};

/** The secret holding one field of a login. */
export const loginFieldKey = (
  agentId: string,
  name: string,
  field: LoginField,
) => botSecretKey(agentId, "login", name, field);

/** The prefix of every field of a login. */
export const loginFieldsPrefix = (agentId: string, name: string) =>
  botSecretsPrefix(agentId, "login", name);

/** A login without its fields, which are secrets of their own. */
export type LoginRecord = Omit<Login, "fields">;

const metadata = {
  name: logins.name,
  hosts: logins.hosts,
  createdAt: logins.createdAt,
  updatedAt: logins.updatedAt,
  lastUsedAt: logins.lastUsedAt,
  lastError: lastUseError("login", logins),
};

const loginOf = (
  row: Omit<LoginRecord, "hosts"> & { hosts: string },
): LoginRecord => ({ ...row, hosts: parseHosts(row.hosts) });

/** The logins the owner gave each bot. */
export class LoginRepository extends Context.Service<
  LoginRepository,
  {
    /** Metadata only: listing never decrypts a value. */
    readonly list: (agentId: string) => Effect.Effect<LoginRecord[]>;
    readonly get: (
      agentId: string,
      name: string,
    ) => Effect.Effect<LoginRecord | undefined>;
    readonly save: (
      agentId: string,
      name: string,
      hosts: readonly string[],
    ) => Effect.Effect<LoginRecord>;
    readonly delete: (agentId: string, name: string) => Effect.Effect<boolean>;
    /** Marks the login used at `at`. */
    readonly touch: (
      agentId: string,
      name: string,
      at: string,
    ) => Effect.Effect<void>;
  }
>()("crumble/logins/LoginRepository") {
  static readonly layer = Layer.effect(
    LoginRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const login = (agentId: string, name: string) =>
        and(eq(logins.agentId, agentId), eq(logins.name, name));

      const list = Effect.fn("LoginRepository.list")(function* (
        agentId: string,
      ) {
        const rows = yield* db
          .select(metadata)
          .from(logins)
          .where(eq(logins.agentId, agentId))
          .orderBy(asc(logins.name));

        return rows.map(loginOf);
      }, Effect.orDie);

      const get = Effect.fn("LoginRepository.get")(function* (
        agentId: string,
        name: string,
      ) {
        const [row] = yield* db
          .select(metadata)
          .from(logins)
          .where(login(agentId, name));

        return row && loginOf(row);
      }, Effect.orDie);

      const save = Effect.fn("LoginRepository.save")(function* (
        agentId: string,
        name: string,
        list: readonly string[],
      ) {
        const at = yield* nowIso;
        const hosts = JSON.stringify(list);

        yield* db
          .insert(logins)
          .values({ agentId, name, hosts, createdAt: at, updatedAt: at })
          .onConflictDoUpdate({
            target: [logins.agentId, logins.name],
            set: { hosts, updatedAt: at },
          });

        return (yield* get(agentId, name))!;
      }, Effect.orDie);

      const remove = Effect.fn("LoginRepository.delete")(function* (
        agentId: string,
        name: string,
      ) {
        const deleted = yield* db
          .delete(logins)
          .where(login(agentId, name))
          .returning({ name: logins.name });

        return deleted.length > 0;
      }, Effect.orDie);

      const touch = Effect.fn("LoginRepository.touch")(function* (
        agentId: string,
        name: string,
        at: string,
      ) {
        yield* db
          .update(logins)
          .set({ lastUsedAt: at })
          .where(login(agentId, name));
      }, Effect.orDie);

      return LoginRepository.of({
        list,
        get,
        save,
        delete: remove,
        touch,
      });
    }),
  );
}
