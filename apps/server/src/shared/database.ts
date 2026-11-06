import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as Drizzle from "drizzle-orm/effect-sqlite-bun";
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator";

export const migrationsFolder = (database: "store" | "push") =>
  fileURLToPath(new URL(`../../drizzle/${database}`, import.meta.url));

export const migrateDatabase = Effect.fn("migrateDatabase")(function* (
  folder: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;

  const db = yield* Drizzle.makeWithDefaults();
  yield* migrate(db, { migrationsFolder: folder });
});

export const migrateFile = (filename: string, folder: string) =>
  migrateDatabase(folder).pipe(
    Effect.provide(SqliteClient.layer({ filename })),
  );

export type SqliteDatabase = Drizzle.EffectSQLiteBunDatabase;

export const sqliteDatabase = Effect.fnUntraced(function* (folder: string) {
  yield* migrateDatabase(folder);

  return yield* Drizzle.makeWithDefaults();
});
