import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import {
  secretSourceOf,
  type SecretSource,
} from "../password-managers/secret-values";
import {
  loginFieldInput,
  type Login,
  type LoginField,
  type LoginRequest,
  type LoginRequestInput,
  type LoginUse,
  type PasswordManagerId,
  type SecretReference,
} from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { nowIso } from "../shared/time";
import { usesBefore, withStringIds } from "../shared/use-log";
import { loginFields, loginRequests, loginUses, logins } from "./schema";

const hostList = z.array(z.string());

/** A field's new source: a value to store, or a reference to read. */
export type FieldSource =
  | { value: string; reference?: undefined }
  | { value?: undefined; reference: SecretReference };

/** What a save writes: the hosts, and per field a new source, or null to remove it. Omitted fields stay. */
export type LoginWrite = {
  hosts: string[];
  fields: Partial<Record<LoginField, FieldSource | null>>;
};

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

type FieldRow = {
  name: string;
  field: LoginField;
  passwordManager: PasswordManagerId | null;
  reference: string | null;
};

const requestOf = (row: typeof loginRequests.$inferSelect): LoginRequest => ({
  name: row.name,
  hosts: hostList.parse(JSON.parse(row.hosts)),
  reason: row.reason,
  oneTimeCode: row.oneTimeCode,
  requestedAt: row.requestedAt,
});

const loginOf = (
  row: Omit<Login, "hosts" | "fields"> & { hosts: string },
  fields: readonly FieldRow[],
): Login => ({
  ...row,
  hosts: hostList.parse(JSON.parse(row.hosts)),
  fields: Object.fromEntries(
    fields.flatMap((field) =>
      field.name === row.name
        ? [
            [
              field.field,
              {
                passwordManager: field.passwordManager,
                reference: field.reference,
              },
            ],
          ]
        : [],
    ),
  ),
});

/** The logins the owner gave each bot, and their fills. */
export class LoginRepository extends Context.Service<
  LoginRepository,
  {
    /** Metadata only: listing never decrypts a value. */
    readonly list: (agentId: string) => Effect.Effect<Login[]>;
    readonly get: (
      agentId: string,
      name: string,
    ) => Effect.Effect<Login | undefined>;
    readonly save: (
      agentId: string,
      name: string,
      write: LoginWrite,
    ) => Effect.Effect<Login>;
    readonly delete: (agentId: string, name: string) => Effect.Effect<boolean>;
    /** Where the field's value comes from, decrypting a stored one; for filling only. */
    readonly source: (
      agentId: string,
      name: string,
      field: LoginField,
    ) => Effect.Effect<SecretSource | undefined>;
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
      const box = yield* SecretBox;

      const login = (agentId: string, name: string) =>
        and(eq(logins.agentId, agentId), eq(logins.name, name));

      const fieldsOf = (agentId: string, name?: string) =>
        db
          .select({
            name: loginFields.name,
            field: loginFields.field,
            passwordManager: loginFields.passwordManager,
            reference: loginFields.reference,
          })
          .from(loginFields)
          .where(
            name === undefined
              ? eq(loginFields.agentId, agentId)
              : and(
                  eq(loginFields.agentId, agentId),
                  eq(loginFields.name, name),
                ),
          );

      const list = Effect.fn("LoginRepository.list")(function* (
        agentId: string,
      ) {
        const rows = yield* db
          .select(metadata)
          .from(logins)
          .where(eq(logins.agentId, agentId))
          .orderBy(asc(logins.name));

        const fields = yield* fieldsOf(agentId);

        return rows.map((row) => loginOf(row, fields));
      }, Effect.orDie);

      const get = Effect.fn("LoginRepository.get")(function* (
        agentId: string,
        name: string,
      ) {
        const [row] = yield* db
          .select(metadata)
          .from(logins)
          .where(login(agentId, name));

        return row ? loginOf(row, yield* fieldsOf(agentId, name)) : undefined;
      }, Effect.orDie);

      const sourceColumns = (source: FieldSource) =>
        source.reference
          ? {
              value: null,
              passwordManager: source.reference.passwordManager,
              reference: source.reference.reference,
            }
          : {
              value: box.encrypt(source.value),
              passwordManager: null,
              reference: null,
            };

      const writeField = (
        agentId: string,
        name: string,
        field: LoginField,
        source: FieldSource | null,
      ) => {
        const where = and(
          eq(loginFields.agentId, agentId),
          eq(loginFields.name, name),
          eq(loginFields.field, field),
        );

        if (!source) return db.delete(loginFields).where(where);

        const columns = sourceColumns(source);

        return db
          .insert(loginFields)
          .values({ agentId, name, field, ...columns })
          .onConflictDoUpdate({
            target: [loginFields.agentId, loginFields.name, loginFields.field],
            set: columns,
          });
      };

      const save = Effect.fn("LoginRepository.save")(function* (
        agentId: string,
        name: string,
        write: LoginWrite,
      ) {
        const at = yield* nowIso;
        const hosts = JSON.stringify(write.hosts);

        yield* db.transaction(() =>
          Effect.gen(function* () {
            yield* db
              .insert(logins)
              .values({ agentId, name, hosts, createdAt: at, updatedAt: at })
              .onConflictDoUpdate({
                target: [logins.agentId, logins.name],
                set: { hosts, updatedAt: at },
              });

            for (const field of loginFieldInput.options) {
              const source = write.fields[field];

              if (source !== undefined)
                yield* writeField(agentId, name, field, source);
            }
          }),
        );

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

      const source = Effect.fn("LoginRepository.source")(function* (
        agentId: string,
        name: string,
        field: LoginField,
      ) {
        const [row] = yield* db
          .select({
            value: loginFields.value,
            passwordManager: loginFields.passwordManager,
            reference: loginFields.reference,
          })
          .from(loginFields)
          .where(
            and(
              eq(loginFields.agentId, agentId),
              eq(loginFields.name, name),
              eq(loginFields.field, field),
            ),
          );

        return row && secretSourceOf(box, row);
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
        source,
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
