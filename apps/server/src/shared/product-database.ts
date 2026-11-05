import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Context, Effect, Layer } from "effect";
import { isSqlError } from "effect/sql/SqlError";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  migrationsFolder,
  sqliteDatabase,
  type SqliteDatabase,
} from "./database";

export const atomic =
  (db: SqliteDatabase) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    db.transaction(() => effect).pipe(Effect.catchIf(isSqlError, Effect.die));

export class ProductDatabase extends Context.Service<
  ProductDatabase,
  SqliteDatabase
>()("crumble/shared/ProductDatabase") {
  static layer(dataDir: string) {
    return Layer.effect(
      ProductDatabase,
      sqliteDatabase(migrationsFolder("store")),
    ).pipe(
      Layer.provide(
        Layer.unwrap(
          Effect.sync(() => {
            mkdirSync(dataDir, { recursive: true });

            return SqliteClient.layer({
              filename: join(dataDir, "store.sqlite"),
            });
          }),
        ),
      ),
    );
  }
}
