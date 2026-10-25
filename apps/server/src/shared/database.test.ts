import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect, Match } from "effect";
import { z } from "zod";
import { migrateFile, migrationsFolder } from "./database";
import { upgradeLegacyStore } from "./legacy-schema";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../test/fixtures", name), "utf8");

function databaseFile(schema?: string) {
  const dir = mkdtempSync("/tmp/crumble-database-");
  dirs.push(dir);
  const file = join(dir, "database.sqlite");

  if (schema) {
    const db = new Database(file);
    db.run(schema);
    db.close();
  }

  return file;
}

const legacyStore = { table: "agents", upgrade: upgradeLegacyStore };

const migrateStore = (file: string) =>
  Effect.runSync(migrateFile(file, migrationsFolder("store"), legacyStore));

const migratePush = (file: string) =>
  Effect.runSync(migrateFile(file, migrationsFolder("push")));

const column = z.object({
  name: z.string(),
  type: z.string(),
  notnull: z.number(),
  dflt_value: z.string().nullable(),
  pk: z.number(),
});

const foreignKey = z.object({
  table: z.string(),
  from: z.string(),
  to: z.string(),
  on_update: z.string(),
  on_delete: z.string(),
});

const indexEntry = z.object({
  name: z.string(),
  unique: z.number(),
  origin: z.string(),
});

const indexColumn = z.object({ name: z.string().nullable() });

// Drizzle writes boolean defaults as `false`/`true`, which SQLite stores as 0/1.
const normalizedDefault = (value: string | null) =>
  Match.value(value).pipe(
    Match.when("false", () => "0"),
    Match.when("true", () => "1"),
    Match.orElse(() => value),
  );

/** Every user table as SQLite reports it, independent of column order, constraint names, and DDL text. */
function schemaOf(file: string) {
  const db = new Database(file, { readonly: true });

  const rows = (query: string) => db.query(query).all();

  const tables = z
    .array(z.object({ name: z.string() }))
    .parse(
      rows(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name",
      ),
    );

  const schema = Object.fromEntries(
    tables.map(({ name }) => {
      const columns = z
        .array(column)
        .parse(rows(`PRAGMA table_info(${name})`))
        .map((each) => ({
          ...each,
          type: each.type.toUpperCase(),
          dflt_value: normalizedDefault(each.dflt_value),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const foreignKeys = z
        .array(foreignKey)
        .parse(rows(`PRAGMA foreign_key_list(${name})`))
        .map((each) => JSON.stringify(each))
        .sort();

      const indexes = z
        .array(indexEntry)
        .parse(rows(`PRAGMA index_list(${name})`))
        .map((each) => {
          const indexed = z
            .array(indexColumn)
            .parse(rows(`PRAGMA index_info(${JSON.stringify(each.name)})`))
            .map((entry) => entry.name);

          // Constraint indexes get generated names, so only created indexes are compared by name.
          return JSON.stringify({
            name: each.origin === "c" ? each.name : each.origin,
            unique: each.unique,
            columns: indexed,
          });
        })
        .sort();

      return [name, { columns, foreignKeys, indexes }];
    }),
  );

  db.close();

  return schema;
}

function migrationsOf(file: string) {
  const db = new Database(file, { readonly: true });

  const names = z
    .array(z.object({ name: z.string() }))
    .parse(db.query("SELECT name FROM __drizzle_migrations").all())
    .map((row) => row.name);

  db.close();

  return names;
}

describe("product database migrations", () => {
  test("a new database gets the schema servers before Drizzle created", () => {
    const fresh = databaseFile();
    migrateStore(fresh);

    expect(schemaOf(fresh)).toEqual(
      schemaOf(databaseFile(fixture("legacy-store-schema.sql"))),
    );
  });

  test("a database from a server before Drizzle keeps its tables and records the baseline", () => {
    const existing = databaseFile(fixture("legacy-store-schema.sql"));
    const db = new Database(existing);
    db.run(
      "INSERT INTO agents (id,name,avatar,description,instructions,provider,model,enabled,tools,skills,mcp_servers,created_at,updated_at) VALUES ('a','A','','','','p','m',1,'[]','[]','[]','t','t')",
    );
    db.close();

    migrateStore(existing);
    const fresh = databaseFile();
    migrateStore(fresh);

    expect(schemaOf(existing)).toEqual(schemaOf(fresh));
    expect(migrationsOf(existing)).toEqual(migrationsOf(fresh));

    const reopened = new Database(existing, { readonly: true });
    expect(reopened.query("SELECT id FROM agents").all()).toEqual([
      { id: "a" },
    ]);
    reopened.close();
  });

  test("the oldest database shape upgrades to the newest schema and keeps its rows", () => {
    const oldest = databaseFile(fixture("oldest-store-schema.sql"));
    const db = new Database(oldest);
    db.run(`INSERT INTO agents (id,name,avatar,description,instructions,provider,model,enabled,tools,skills,mcp_servers,folder,created_at,updated_at) VALUES ('a','A','','','','p','m',1,'[]','[]','[]','old','t','t');
      INSERT INTO memories (id,agent_id,content,created_at,updated_at) VALUES ('m','a','Remember','t','t');
      INSERT INTO group_chats (id,name,created_at,updated_at) VALUES ('g','Trip','t','t');
      INSERT INTO group_members (group_id,agent_id,joined_at) VALUES ('g','a','t');`);
    db.close();

    migrateStore(oldest);
    const fresh = databaseFile();
    migrateStore(fresh);

    expect(schemaOf(oldest)).toEqual(schemaOf(fresh));

    const upgraded = new Database(oldest, { readonly: true });
    expect(
      upgraded
        .query("SELECT id, agent_id, content, source FROM memories")
        .all(),
    ).toEqual([{ id: "m", agent_id: "a", content: "Remember", source: null }]);
    expect(
      upgraded
        .query("SELECT cursor, pending, summary FROM group_members")
        .all(),
    ).toEqual([{ cursor: 0, pending: 0, summary: null }]);
    upgraded.close();
  });

  test("migrating again changes nothing", () => {
    const file = databaseFile();
    migrateStore(file);
    const before = schemaOf(file);

    migrateStore(file);
    expect(schemaOf(file)).toEqual(before);
    expect(migrationsOf(file)).toHaveLength(1);
  });
});

describe("push database migrations", () => {
  test("a new database matches, and an existing one records the baseline", () => {
    const fresh = databaseFile();
    migratePush(fresh);
    const existing = databaseFile(fixture("legacy-push-schema.sql"));
    migratePush(existing);

    expect(schemaOf(fresh)).toEqual(
      schemaOf(databaseFile(fixture("legacy-push-schema.sql"))),
    );
    expect(schemaOf(existing)).toEqual(schemaOf(fresh));
    expect(migrationsOf(existing)).toEqual(migrationsOf(fresh));
  });
});
