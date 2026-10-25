import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as Drizzle from "drizzle-orm/effect-sqlite-bun";
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator";

/** Where drizzle-kit writes a database's migrations; see drizzle.store.config.ts and drizzle.push.config.ts. */
export const migrationsFolder = (database: "store" | "push") =>
  fileURLToPath(new URL(`../../drizzle/${database}`, import.meta.url));

const tableNames = Schema.Array(Schema.Struct({ name: Schema.String }));

/** The database's own tables, without SQLite's internal ones. */
export const listTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;

  return new Set(
    (yield* Schema.decodeUnknownEffect(tableNames)(rows)).map(
      (row) => row.name,
    ),
  );
});

/**
 * Brings a database to its newest migration. A database created before Drizzle, recognized by `legacyTable` and no
 * migrations table, first gets `legacyUpgrade`, which brings it to the baseline that the first migration records.
 */
export const migrateDatabase = Effect.fn("migrateDatabase")(function* (
  folder: string,
  legacy?: {
    readonly table: string;
    readonly upgrade: Effect.Effect<void, unknown, SqlClient.SqlClient>;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  const tables = yield* listTables;

  if (legacy && tables.has(legacy.table) && !tables.has("__drizzle_migrations"))
    yield* legacy.upgrade;

  const db = yield* Drizzle.makeWithDefaults();
  yield* migrate(db, { migrationsFolder: folder });
});

/** Migrates the database file on a connection of its own, closed when done. */
export const migrateFile = (
  filename: string,
  folder: string,
  legacy?: Parameters<typeof migrateDatabase>[1],
) =>
  migrateDatabase(folder, legacy).pipe(
    Effect.provide(SqliteClient.layer({ filename })),
  );

export type SqliteDatabase = Drizzle.EffectSQLiteBunDatabase;

/** A Drizzle database on the provided SQLite client, migrated first; the client's layer closes it. */
export const sqliteDatabase = Effect.fnUntraced(function* (
  folder: string,
  legacy?: Parameters<typeof migrateDatabase>[1],
) {
  yield* migrateDatabase(folder, legacy);

  return yield* Drizzle.makeWithDefaults();
});
