import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Context, Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  migrationsFolder,
  sqliteDatabase,
  type SqliteDatabase,
} from "./database";
import { upgradeLegacyStore } from "./legacy-schema";

/** An account's product database (store.sqlite): bots, chats, memories, skills, and everything they own. */
export class ProductDatabase extends Context.Service<
  ProductDatabase,
  SqliteDatabase
>()("crumble/shared/ProductDatabase") {
  static layer(dataDir: string) {
    return Layer.effect(
      ProductDatabase,
      sqliteDatabase(migrationsFolder("store"), {
        table: "agents",
        upgrade: upgradeLegacyStore,
      }),
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
