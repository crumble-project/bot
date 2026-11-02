import type { Credential, CredentialInfo } from "@earendil-works/pi-ai";
import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
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

/** Each model provider's sign-in, or its API key's other fields; the key itself is a secret (`providerApiKeyKey`). */
export class ProviderCredentialRepository extends Context.Service<
  ProviderCredentialRepository,
  {
    readonly get: (providerId: string) => Effect.Effect<Credential | undefined>;
    readonly set: (
      providerId: string,
      credential: Credential,
    ) => Effect.Effect<void>;
    readonly delete: (providerId: string) => Effect.Effect<boolean>;
    /** Metadata only: listing never decrypts a credential. */
    readonly list: Effect.Effect<CredentialInfo[]>;
  }
>()("crumble/providers/ProviderCredentialRepository") {
  static readonly layer = Layer.effect(
    ProviderCredentialRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const box = yield* SecretBox;

      const get = Effect.fn("ProviderCredentialRepository.get")(function* (
        providerId: string,
      ) {
        const [row] = yield* db
          .select({ value: providerCredentials.value })
          .from(providerCredentials)
          .where(eq(providerCredentials.provider, providerId));

        if (!row) return undefined;

        return row.value === null
          ? { type: "api_key" as const }
          : providerCredential.parse(JSON.parse(box.decrypt(row.value)));
      }, Effect.orDie);

      const set = Effect.fn("ProviderCredentialRepository.set")(function* (
        providerId: string,
        credential: Credential,
      ) {
        const typed = providerCredential.parse(credential);

        const row = {
          type: typed.type,
          value: box.encrypt(JSON.stringify(typed)),
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
        })
        .from(providerCredentials)
        .orderBy(asc(providerCredentials.provider))
        .pipe(
          Effect.orDie,
          Effect.withSpan("ProviderCredentialRepository.list"),
        );

      return ProviderCredentialRepository.of({
        get,
        set,
        delete: remove,
        list,
      });
    }),
  );
}
