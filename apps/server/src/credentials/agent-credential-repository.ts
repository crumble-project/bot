import { and, asc, desc, eq, lt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import type {
  AgentCredential,
  CredentialGrant,
  CredentialRequest,
  CredentialUse,
} from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { nowIso } from "../shared/time";
import {
  agentCredentials,
  credentialAuthorities,
  credentialRequests,
  credentialUses,
} from "./schema";

const hostList = z.array(z.string());

const credentialOf = (row: {
  name: string;
  hosts: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}): AgentCredential => ({
  name: row.name,
  hosts: hostList.parse(JSON.parse(row.hosts)),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  lastUsedAt: row.lastUsedAt,
});

const requestOf = (
  row: typeof credentialRequests.$inferSelect,
): CredentialRequest => ({
  name: row.name,
  hosts: hostList.parse(JSON.parse(row.hosts)),
  reason: row.reason,
  requestedAt: row.requestedAt,
});

export type CredentialAuthority = { certificate: string; key: string };

const metadata = {
  name: agentCredentials.name,
  hosts: agentCredentials.hosts,
  createdAt: agentCredentials.createdAt,
  updatedAt: agentCredentials.updatedAt,
  lastUsedAt: agentCredentials.lastUsedAt,
};

/** The credentials the owner gave each bot, their requests, uses, and each bot's certificate authority. */
export class AgentCredentialRepository extends Context.Service<
  AgentCredentialRepository,
  {
    /** Metadata only: listing never decrypts a value. */
    readonly list: (agentId: string) => Effect.Effect<AgentCredential[]>;
    readonly get: (
      agentId: string,
      name: string,
    ) => Effect.Effect<AgentCredential | undefined>;
    /** Creating needs a value; updating keeps the stored one when `value` is omitted. The placeholder never changes. */
    readonly save: (
      agentId: string,
      name: string,
      input: {
        hosts: string[];
        value?: string | undefined;
        placeholder: string;
      },
    ) => Effect.Effect<AgentCredential>;
    readonly delete: (agentId: string, name: string) => Effect.Effect<boolean>;
    /** Each credential's placeholder by name, for the bot's job environments. */
    readonly placeholders: (
      agentId: string,
    ) => Effect.Effect<Record<string, string>>;
    /** Every credential with its placeholder and decrypted value, for the credential proxy only. */
    readonly grants: (agentId: string) => Effect.Effect<CredentialGrant[]>;
    /** The bot's certificate authority for the credential proxy, with its private key in PKCS #8 PEM. */
    readonly getAuthority: (
      agentId: string,
    ) => Effect.Effect<CredentialAuthority | undefined>;
    /** Keeps the first authority saved for a bot, so concurrent callers agree on one. */
    readonly saveAuthority: (
      agentId: string,
      authority: CredentialAuthority,
    ) => Effect.Effect<CredentialAuthority>;
    readonly listRequests: (
      agentId: string,
    ) => Effect.Effect<CredentialRequest[]>;
    readonly getRequest: (
      agentId: string,
      name: string,
    ) => Effect.Effect<CredentialRequest | undefined>;
    /** A repeated request replaces the earlier one. */
    readonly setRequest: (
      agentId: string,
      request: { name: string; hosts: string[]; reason: string },
    ) => Effect.Effect<CredentialRequest>;
    readonly deleteRequest: (
      agentId: string,
      name: string,
    ) => Effect.Effect<boolean>;
    readonly addUse: (
      agentId: string,
      name: string,
      use: Omit<CredentialUse, "id">,
    ) => Effect.Effect<void>;
    /** Newest first; page with `before` set to the last use's ID. */
    readonly listUses: (
      agentId: string,
      name: string,
      options: { limit: number; before?: string | undefined },
    ) => Effect.Effect<CredentialUse[]>;
    readonly pruneUses: (olderThan: string) => Effect.Effect<void>;
  }
>()("crumble/credentials/AgentCredentialRepository") {
  static readonly layer = Layer.effect(
    AgentCredentialRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const box = yield* SecretBox;

      const credential = (agentId: string, name: string) =>
        and(
          eq(agentCredentials.agentId, agentId),
          eq(agentCredentials.name, name),
        );

      const request = (agentId: string, name: string) =>
        and(
          eq(credentialRequests.agentId, agentId),
          eq(credentialRequests.name, name),
        );

      const list = Effect.fn("AgentCredentialRepository.list")(function* (
        agentId: string,
      ) {
        const rows = yield* db
          .select(metadata)
          .from(agentCredentials)
          .where(eq(agentCredentials.agentId, agentId))
          .orderBy(asc(agentCredentials.name));

        return rows.map(credentialOf);
      }, Effect.orDie);

      const get = Effect.fn("AgentCredentialRepository.get")(function* (
        agentId: string,
        name: string,
      ) {
        const [row] = yield* db
          .select(metadata)
          .from(agentCredentials)
          .where(credential(agentId, name));

        return row ? credentialOf(row) : undefined;
      }, Effect.orDie);

      const save = Effect.fn("AgentCredentialRepository.save")(function* (
        agentId: string,
        name: string,
        input: {
          hosts: string[];
          value?: string | undefined;
          placeholder: string;
        },
      ) {
        const at = yield* nowIso;
        const hosts = JSON.stringify(input.hosts);

        if (yield* get(agentId, name)) {
          yield* db
            .update(agentCredentials)
            .set(
              input.value === undefined
                ? { hosts, updatedAt: at }
                : { hosts, value: box.encrypt(input.value), updatedAt: at },
            )
            .where(credential(agentId, name));
        } else {
          if (input.value === undefined)
            return yield* Effect.die(
              new Error("A new credential needs a value"),
            );

          yield* db.insert(agentCredentials).values({
            agentId,
            name,
            hosts,
            value: box.encrypt(input.value),
            placeholder: input.placeholder,
            createdAt: at,
            updatedAt: at,
          });
        }

        return (yield* get(agentId, name))!;
      }, Effect.orDie);

      const remove = Effect.fn("AgentCredentialRepository.delete")(function* (
        agentId: string,
        name: string,
      ) {
        const deleted = yield* db
          .delete(agentCredentials)
          .where(credential(agentId, name))
          .returning({ name: agentCredentials.name });

        return deleted.length > 0;
      }, Effect.orDie);

      const placeholders = Effect.fn("AgentCredentialRepository.placeholders")(
        function* (agentId: string) {
          const rows = yield* db
            .select({
              name: agentCredentials.name,
              placeholder: agentCredentials.placeholder,
            })
            .from(agentCredentials)
            .where(eq(agentCredentials.agentId, agentId))
            .orderBy(asc(agentCredentials.name));

          return Object.fromEntries(
            rows.map((row) => [row.name, row.placeholder]),
          );
        },
        Effect.orDie,
      );

      const grants = Effect.fn("AgentCredentialRepository.grants")(function* (
        agentId: string,
      ) {
        const rows = yield* db
          .select({
            name: agentCredentials.name,
            hosts: agentCredentials.hosts,
            placeholder: agentCredentials.placeholder,
            value: agentCredentials.value,
          })
          .from(agentCredentials)
          .where(eq(agentCredentials.agentId, agentId))
          .orderBy(asc(agentCredentials.name));

        return rows.map((row): CredentialGrant => ({
          name: row.name,
          hosts: hostList.parse(JSON.parse(row.hosts)),
          placeholder: row.placeholder,
          value: box.decrypt(row.value),
        }));
      }, Effect.orDie);

      const getAuthority = Effect.fn("AgentCredentialRepository.getAuthority")(
        function* (agentId: string) {
          const [row] = yield* db
            .select()
            .from(credentialAuthorities)
            .where(eq(credentialAuthorities.agentId, agentId));

          return row
            ? { certificate: row.certificate, key: box.decrypt(row.key) }
            : undefined;
        },
        Effect.orDie,
      );

      const saveAuthority = Effect.fn(
        "AgentCredentialRepository.saveAuthority",
      )(function* (agentId: string, authority: CredentialAuthority) {
        yield* db
          .insert(credentialAuthorities)
          .values({
            agentId,
            certificate: authority.certificate,
            key: box.encrypt(authority.key),
          })
          .onConflictDoNothing({ target: credentialAuthorities.agentId });

        return (yield* getAuthority(agentId))!;
      }, Effect.orDie);

      const listRequests = Effect.fn("AgentCredentialRepository.listRequests")(
        function* (agentId: string) {
          const rows = yield* db
            .select()
            .from(credentialRequests)
            .where(eq(credentialRequests.agentId, agentId))
            .orderBy(asc(credentialRequests.requestedAt));

          return rows.map(requestOf);
        },
        Effect.orDie,
      );

      const getRequest = Effect.fn("AgentCredentialRepository.getRequest")(
        function* (agentId: string, name: string) {
          const [row] = yield* db
            .select()
            .from(credentialRequests)
            .where(request(agentId, name));

          return row ? requestOf(row) : undefined;
        },
        Effect.orDie,
      );

      const setRequest = Effect.fn("AgentCredentialRepository.setRequest")(
        function* (
          agentId: string,
          input: { name: string; hosts: string[]; reason: string },
        ) {
          const row = {
            hosts: JSON.stringify(input.hosts),
            reason: input.reason,
            requestedAt: yield* nowIso,
          };

          yield* db
            .insert(credentialRequests)
            .values({ agentId, name: input.name, ...row })
            .onConflictDoUpdate({
              target: [credentialRequests.agentId, credentialRequests.name],
              set: row,
            });

          return (yield* getRequest(agentId, input.name))!;
        },
        Effect.orDie,
      );

      const deleteRequest = Effect.fn(
        "AgentCredentialRepository.deleteRequest",
      )(function* (agentId: string, name: string) {
        const deleted = yield* db
          .delete(credentialRequests)
          .where(request(agentId, name))
          .returning({ name: credentialRequests.name });

        return deleted.length > 0;
      }, Effect.orDie);

      const addUse = Effect.fn("AgentCredentialRepository.addUse")(function* (
        agentId: string,
        name: string,
        use: Omit<CredentialUse, "id">,
      ) {
        yield* db.transaction(() =>
          Effect.gen(function* () {
            yield* db.insert(credentialUses).values({
              agentId,
              name,
              at: use.at,
              method: use.method,
              host: use.host,
              path: use.path,
              status: use.status,
            });
            yield* db
              .update(agentCredentials)
              .set({ lastUsedAt: use.at })
              .where(credential(agentId, name));
          }),
        );
      }, Effect.orDie);

      const listUses = Effect.fn("AgentCredentialRepository.listUses")(
        function* (
          agentId: string,
          name: string,
          options: { limit: number; before?: string | undefined },
        ) {
          const before = Number(options.before);

          const rows = yield* db
            .select({
              id: credentialUses.id,
              at: credentialUses.at,
              method: credentialUses.method,
              host: credentialUses.host,
              path: credentialUses.path,
              status: credentialUses.status,
            })
            .from(credentialUses)
            .where(
              and(
                eq(credentialUses.agentId, agentId),
                eq(credentialUses.name, name),
                lt(
                  credentialUses.id,
                  Number.isSafeInteger(before) && before > 0
                    ? before
                    : Number.MAX_SAFE_INTEGER,
                ),
              ),
            )
            .orderBy(desc(credentialUses.id))
            .limit(options.limit);

          return rows.map((row) => ({ ...row, id: String(row.id) }));
        },
        Effect.orDie,
      );

      const pruneUses = Effect.fn("AgentCredentialRepository.pruneUses")(
        function* (olderThan: string) {
          yield* db
            .delete(credentialUses)
            .where(lt(credentialUses.at, olderThan));
        },
        Effect.orDie,
      );

      return AgentCredentialRepository.of({
        list,
        get,
        save,
        delete: remove,
        placeholders,
        grants,
        getAuthority,
        saveAuthority,
        listRequests,
        getRequest,
        setRequest,
        deleteRequest,
        addUse,
        listUses,
        pruneUses,
      });
    }),
  );
}
