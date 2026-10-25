import type { JsonValue } from "@earendil-works/chord";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ProductDatabase } from "./product-database";
import { settings } from "./schema";

/** Account settings as JSON values by key. */
export class SettingsRepository extends Context.Service<
  SettingsRepository,
  {
    readonly get: (key: string) => Effect.Effect<JsonValue | undefined>;
    readonly set: (key: string, value: JsonValue) => Effect.Effect<void>;
    readonly delete: (key: string) => Effect.Effect<boolean>;
    readonly list: Effect.Effect<Record<string, JsonValue>>;
  }
>()("crumble/shared/SettingsRepository") {
  static readonly layer = Layer.effect(
    SettingsRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const get = Effect.fn("SettingsRepository.get")(function* (key: string) {
        const [row] = yield* db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, key));

        const value: JsonValue | undefined = row
          ? JSON.parse(row.value)
          : undefined;

        return value;
      }, Effect.orDie);

      const set = Effect.fn("SettingsRepository.set")(function* (
        key: string,
        value: JsonValue,
      ) {
        const json = JSON.stringify(value);

        yield* db
          .insert(settings)
          .values({ key, value: json })
          .onConflictDoUpdate({ target: settings.key, set: { value: json } });
      }, Effect.orDie);

      const remove = Effect.fn("SettingsRepository.delete")(function* (
        key: string,
      ) {
        const deleted = yield* db
          .delete(settings)
          .where(eq(settings.key, key))
          .returning({ key: settings.key });

        return deleted.length > 0;
      }, Effect.orDie);

      const list = db
        .select()
        .from(settings)
        .pipe(
          Effect.map((rows) => {
            const out: Record<string, JsonValue> = {};

            for (const row of rows) out[row.key] = JSON.parse(row.value);

            return out;
          }),
          Effect.orDie,
          Effect.withSpan("SettingsRepository.list"),
        );

      return SettingsRepository.of({ get, set, delete: remove, list });
    }),
  );
}
