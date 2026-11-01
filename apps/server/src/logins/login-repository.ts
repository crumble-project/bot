import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import { secretKey, secretKeyPrefix } from "../password-managers/secrets";
import type {
  Login,
  LoginField,
  LoginRequest,
  LoginRequestInput,
  LoginUse,
} from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { usesBefore, withStringIds } from "../shared/use-log";
import { loginRequests, loginUses, logins } from "./schema";

const hostList = z.array(z.string());

/** The secret holding one field of a login; under the bot's prefix, so deleting the bot deletes it. */
export const loginFieldKey = (
  agentId: string,
  name: string,
  field: LoginField,
) => secretKey("bot", agentId, "login", name, field);

/** The prefix of every field of a login. */
export const loginFieldsPrefix = (agentId: string, name: string) =>
  secretKeyPrefix("bot", agentId, "login", name);

/** A login without its fields, which are secrets of their own. */
export type LoginRecord = Omit<Login, "fields">;

const metadata = {
  name: logins.name,
  hosts: logins.hosts,
  createdAt: logins.createdAt,
  updatedAt: logins.updatedAt,
  lastUsedAt: logins.lastUsedAt,
  lastError: sql<
    string | null
  >`(SELECT ${loginUses.error} FROM ${loginUses} WHERE ${loginUses.agentId} = ${logins.agentId} AND ${loginUses.name} = ${logins.name} ORDER BY ${loginUses.id} DESC LIMIT 1)`,
};

const requestOf = (row: typeof loginRequests.$inferSelect): LoginRequest => ({
  name: row.name,
  hosts: hostList.parse(JSON.parse(row.hosts)),
  reason: row.reason,
  oneTimeCode: row.oneTimeCode,
  requestedAt: row.requestedAt,
});

const loginOf = (
  row: Omit<LoginRecord, "hosts"> & { hosts: string },
): LoginRecord => ({ ...row, hosts: hostList.parse(JSON.parse(row.hosts)) });

/** The logins the owner gave each bot, and their fills. */
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
    readonly addUse: (
      agentId: string,
      name: string,
      use: Omit<LoginUse, "id">,
    ) => Effect.Effect<void>;
    /** Newest first; page with `before` set to the last use's ID. */
    readonly listUses: (
      agentId: string,
      name: string,
      options: { limit: number; before?: string | undefined },
    ) => Effect.Effect<LoginUse[]>;
    readonly pruneUses: (olderThan: string) => Effect.Effect<void>;
    readonly listRequests: (agentId: string) => Effect.Effect<LoginRequest[]>;
    readonly getRequest: (
      agentId: string,
      name: string,
    ) => Effect.Effect<LoginRequest | undefined>;
    /** A repeated request replaces the earlier one. */
    readonly setRequest: (
      agentId: string,
      request: LoginRequestInput,
    ) => Effect.Effect<LoginRequest>;
    readonly deleteRequest: (
      agentId: string,
      name: string,
    ) => Effect.Effect<boolean>;
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

      const addUse = Effect.fn("LoginRepository.addUse")(function* (
        agentId: string,
        name: string,
        use: Omit<LoginUse, "id">,
      ) {
        yield* db.transaction(() =>
          Effect.gen(function* () {
            yield* db.insert(loginUses).values({ agentId, name, ...use });
            yield* db
              .update(logins)
              .set({ lastUsedAt: use.at })
              .where(login(agentId, name));
          }),
        );
      }, Effect.orDie);

      const listUses = Effect.fn("LoginRepository.listUses")(function* (
        agentId: string,
        name: string,
        options: { limit: number; before?: string | undefined },
      ) {
        const rows = yield* db
          .select({
            id: loginUses.id,
            at: loginUses.at,
            host: loginUses.host,
            field: loginUses.field,
            error: loginUses.error,
          })
          .from(loginUses)
          .where(usesBefore(loginUses, agentId, name, options.before))
          .orderBy(desc(loginUses.id))
          .limit(options.limit);

        return withStringIds(rows);
      }, Effect.orDie);

      const pruneUses = Effect.fn("LoginRepository.pruneUses")(function* (
        olderThan: string,
      ) {
        yield* db.delete(loginUses).where(lt(loginUses.at, olderThan));
      }, Effect.orDie);

      const request = (agentId: string, name: string) =>
        and(eq(loginRequests.agentId, agentId), eq(loginRequests.name, name));

      const listRequests = Effect.fn("LoginRepository.listRequests")(function* (
        agentId: string,
      ) {
        const rows = yield* db
          .select()
          .from(loginRequests)
          .where(eq(loginRequests.agentId, agentId))
          .orderBy(asc(loginRequests.requestedAt));

        return rows.map(requestOf);
      }, Effect.orDie);

      const getRequest = Effect.fn("LoginRepository.getRequest")(function* (
        agentId: string,
        name: string,
      ) {
        const [row] = yield* db
          .select()
          .from(loginRequests)
          .where(request(agentId, name));

        return row ? requestOf(row) : undefined;
      }, Effect.orDie);

      const setRequest = Effect.fn("LoginRepository.setRequest")(function* (
        agentId: string,
        input: LoginRequestInput,
      ) {
        const row = {
          hosts: JSON.stringify(input.hosts),
          reason: input.reason,
          oneTimeCode: input.one_time_code ?? false,
          requestedAt: yield* nowIso,
        };

        yield* db
          .insert(loginRequests)
          .values({ agentId, name: input.name, ...row })
          .onConflictDoUpdate({
            target: [loginRequests.agentId, loginRequests.name],
            set: row,
          });

        return (yield* getRequest(agentId, input.name))!;
      }, Effect.orDie);

      const deleteRequest = Effect.fn("LoginRepository.deleteRequest")(
        function* (agentId: string, name: string) {
          const deleted = yield* db
            .delete(loginRequests)
            .where(request(agentId, name))
            .returning({ name: loginRequests.name });

          return deleted.length > 0;
        },
        Effect.orDie,
      );

      return LoginRepository.of({
        list,
        get,
        save,
        delete: remove,
        addUse,
        listUses,
        pruneUses,
        listRequests,
        getRequest,
        setRequest,
        deleteRequest,
      });
    }),
  );
}
