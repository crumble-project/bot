import type { JsonValue } from "@earendil-works/chord";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import { ProductDatabase } from "./product-database";
import { settings } from "./schema";

export class SettingsRepository extends Context.Service<
  SettingsRepository,
  {
    readonly get: (key: string) => Effect.Effect<JsonValue | undefined>;
    readonly set: (key: string, value: JsonValue) => Effect.Effect<void>;
    readonly delete: (key: string) => Effect.Effect<boolean>;
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
          ? z.json().parse(JSON.parse(row.value))
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

      return SettingsRepository.of({ get, set, delete: remove });
    }),
  );
}
