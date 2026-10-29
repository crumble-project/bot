import type { Credential, CredentialInfo } from "@earendil-works/pi-ai";
import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Redacted } from "effect";
import { z } from "zod";
import { SecretRepository } from "../credentials/secret-repository";
import type { PasswordManagerId } from "../password-managers/password-manager";
import type { SecretReference } from "../password-managers/secret-references";
import { secretSourceOf } from "../password-managers/secret-values";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { providerCredentials } from "./schema";

/** Typed provider credentials keep provider-specific fields such as account IDs and enterprise URLs. */
const providerCredential = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("api_key"),
      key: z.string().exactOptional(),
      env: z.record(z.string(), z.string()).exactOptional(),
    })
    .loose(),
  z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
    })
    .loose(),
]);

/** Where a provider's credential comes from: stored in Crumble, or an API key read from a password manager. */
export type ProviderCredentialSource =
  | { readonly credential: Credential }
  | {
      readonly passwordManager: PasswordManagerId;
      readonly reference: string;
    };

/** A saved credential's metadata, with the password manager reference an API key is read from. */
export type ProviderCredentialInfo = CredentialInfo & {
  passwordManager: PasswordManagerId | null;
  reference: string | null;
};

/** Each model provider's sign-in or API key, encrypted at rest. */
export class ProviderCredentialRepository extends Context.Service<
  ProviderCredentialRepository,
  {
    readonly get: (
      providerId: string,
    ) => Effect.Effect<ProviderCredentialSource | undefined>;
    readonly set: (
      providerId: string,
      credential: Credential,
    ) => Effect.Effect<void>;
    /** Reads the API key from a password manager, replacing any credential stored in Crumble. */
    readonly setReference: (
      providerId: string,
      source: SecretReference,
    ) => Effect.Effect<void>;
    readonly delete: (providerId: string) => Effect.Effect<boolean>;
    /** Metadata only: listing never decrypts a credential. */
    readonly list: Effect.Effect<ProviderCredentialInfo[]>;
    /** Moves API keys saved before typed credentials into the provider table; MCP keys never match a provider ID. */
    readonly migrateApiKeys: (
      providerIds: readonly string[],
    ) => Effect.Effect<void>;
  }
>()("crumble/providers/ProviderCredentialRepository") {
  static readonly layer = Layer.effect(
    ProviderCredentialRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const box = yield* SecretBox;
      const secrets = yield* SecretRepository;

      const get = Effect.fn("ProviderCredentialRepository.get")(function* (
        providerId: string,
      ) {
        const [row] = yield* db
          .select({
            value: providerCredentials.value,
            passwordManager: providerCredentials.passwordManager,
            reference: providerCredentials.reference,
          })
          .from(providerCredentials)
          .where(eq(providerCredentials.provider, providerId));

        if (!row) return undefined;

        const source = secretSourceOf(box, row);

        return "stored" in source
          ? {
              credential: providerCredential.parse(
                JSON.parse(Redacted.value(source.stored)),
              ),
            }
          : source;
      }, Effect.orDie);

      const set = Effect.fn("ProviderCredentialRepository.set")(function* (
        providerId: string,
        credential: Credential,
      ) {
        const typed = providerCredential.parse(credential);

        // Saving a credential in Crumble replaces a password manager reference.
        const row = {
          type: typed.type,
          value: box.encrypt(JSON.stringify(typed)),
          passwordManager: null,
          reference: null,
        };

        yield* db
          .insert(providerCredentials)
          .values({ provider: providerId, ...row })
          .onConflictDoUpdate({
            target: providerCredentials.provider,
            set: row,
          });
      }, Effect.orDie);

      const setReference = Effect.fn(
        "ProviderCredentialRepository.setReference",
      )(function* (providerId: string, source: SecretReference) {
        const row = {
          type: "api_key" as const,
          value: null,
          passwordManager: source.passwordManager,
          reference: source.reference,
        };

        yield* db
          .insert(providerCredentials)
          .values({ provider: providerId, ...row })
          .onConflictDoUpdate({
            target: providerCredentials.provider,
            set: row,
          });
      }, Effect.orDie);

      const remove = Effect.fn("ProviderCredentialRepository.delete")(
        function* (providerId: string) {
          const deleted = yield* db
            .delete(providerCredentials)
            .where(eq(providerCredentials.provider, providerId))
            .returning({ provider: providerCredentials.provider });

          return deleted.length > 0;
        },
        Effect.orDie,
      );

      const list = db
        .select({
          providerId: providerCredentials.provider,
          type: providerCredentials.type,
          passwordManager: providerCredentials.passwordManager,
          reference: providerCredentials.reference,
        })
        .from(providerCredentials)
        .orderBy(asc(providerCredentials.provider))
        .pipe(
          Effect.orDie,
          Effect.withSpan("ProviderCredentialRepository.list"),
        );

      const migrateApiKeys = Effect.fn(
        "ProviderCredentialRepository.migrateApiKeys",
      )(function* (providerIds: readonly string[]) {
        yield* db.transaction(() =>
          Effect.gen(function* () {
            for (const providerId of providerIds) {
              const key = yield* secrets.get(providerId);

              if (key === undefined) continue;

              const [existing] = yield* db
                .select({ provider: providerCredentials.provider })
                .from(providerCredentials)
                .where(eq(providerCredentials.provider, providerId));

              if (!existing) yield* set(providerId, { type: "api_key", key });
              yield* secrets.delete(providerId);
            }
          }),
        );
      }, Effect.orDie);

      return ProviderCredentialRepository.of({
        get,
        set,
        setReference,
        delete: remove,
        list,
        migrateApiKeys,
      });
    }),
  );
}
