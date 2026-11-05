import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { parseHosts } from "../bot-secrets/schema";
import { lastUseError } from "../bot-secrets/bot-secret-uses";
import type { AgentCredential, CredentialGrant } from "../shared/domain";
import { botSecretKey } from "../secrets/secret-key";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { nowIso } from "../shared/time";
import { agentCredentials, credentialAuthorities } from "./schema";

/** The secret holding a credential's value. */
export const credentialSecretKey = (agentId: string, name: string) =>
  botSecretKey(agentId, "credential", name);

/** A credential without where its value comes from, which the credential's secret knows. */
export type CredentialRecord = Omit<AgentCredential, "secret">;

const credentialOf = (row: {
  name: string;
  hosts: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  lastError: string | null;
  github: boolean;
}): CredentialRecord => ({
  ...row,
  hosts: parseHosts(row.hosts),
});

export type CredentialAuthority = { certificate: string; key: string };

const metadata = {
  name: agentCredentials.name,
  hosts: agentCredentials.hosts,
  createdAt: agentCredentials.createdAt,
  updatedAt: agentCredentials.updatedAt,
  lastUsedAt: agentCredentials.lastUsedAt,
  github: agentCredentials.github,
  lastError: lastUseError("credential", agentCredentials),
};

/** The credentials the owner gave each bot, and each bot's certificate authority. */
export class AgentCredentialRepository extends Context.Service<
  AgentCredentialRepository,
  {
    /** Metadata only: listing never decrypts a value. */
    readonly list: (agentId: string) => Effect.Effect<CredentialRecord[]>;
    readonly get: (
      agentId: string,
      name: string,
    ) => Effect.Effect<CredentialRecord | undefined>;
    /** Creates or updates a credential; the placeholder is made once and never changes. Its value is a secret of its own. */
    readonly save: (
      agentId: string,
      name: string,
      input: { hosts: string[]; github: boolean },
    ) => Effect.Effect<CredentialRecord>;
    readonly delete: (agentId: string, name: string) => Effect.Effect<boolean>;
    /** Each credential's placeholder by name, for the bot's job environments. */
    readonly placeholders: (
      agentId: string,
    ) => Effect.Effect<Record<string, string>>;
    /** Every credential with its hosts and placeholder, without its value. */
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
    /** Marks the credential used at `at`. */
    readonly touch: (
      agentId: string,
      name: string,
      at: string,
    ) => Effect.Effect<void>;
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
        input: { hosts: string[]; github: boolean },
      ) {
        const at = yield* nowIso;
        const hosts = JSON.stringify(input.hosts);

        if (yield* get(agentId, name)) {
          yield* db
            .update(agentCredentials)
            .set({ hosts, github: input.github, updatedAt: at })
            .where(credential(agentId, name));
        } else {
          yield* db.insert(agentCredentials).values({
            agentId,
            name,
            hosts,
            github: input.github,
            placeholder: `crumble-credential-${randomBytes(24).toString("hex")}`,
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
          })
          .from(agentCredentials)
          .where(eq(agentCredentials.agentId, agentId))
          .orderBy(asc(agentCredentials.name));

        return rows.map((row): CredentialGrant => ({
          name: row.name,
          hosts: parseHosts(row.hosts),
          placeholder: row.placeholder,
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

      const touch = Effect.fn("AgentCredentialRepository.touch")(function* (
        agentId: string,
        name: string,
        at: string,
      ) {
        yield* db
          .update(agentCredentials)
          .set({ lastUsedAt: at })
          .where(credential(agentId, name));
      }, Effect.orDie);

      return AgentCredentialRepository.of({
        list,
        get,
        save,
        delete: remove,
        placeholders,
        grants,
        getAuthority,
        saveAuthority,
        touch,
      });
    }),
  );
}
