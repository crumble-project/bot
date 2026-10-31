import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
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
  test("a new database matches the migrated legacy schema", () => {
    const fresh = databaseFile();
    migrateStore(fresh);
    const legacy = databaseFile(fixture("legacy-store-schema.sql"));
    migrateStore(legacy);

    expect(schemaOf(fresh)).toEqual(schemaOf(legacy));
    const schema = schemaOf(fresh);
    expect(schema["schedules"]?.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "kind",
          notnull: 1,
          dflt_value: "'prompt'",
        }),
        expect.objectContaining({ name: "command", notnull: 0 }),
        expect.objectContaining({
          name: "timeout_seconds",
          notnull: 1,
          dflt_value: "600",
        }),
        expect.objectContaining({
          name: "notify",
          notnull: 1,
          dflt_value: "1",
        }),
      ]),
    );
    expect(schema["script_runs"]?.foreignKeys).toContain(
      JSON.stringify({
        table: "schedules",
        from: "schedule_id",
        to: "id",
        on_update: "NO ACTION",
        on_delete: "CASCADE",
      }),
    );
    expect(schema["script_runs"]?.indexes).toEqual(
      expect.arrayContaining([
        JSON.stringify({
          name: "script_runs_by_schedule",
          unique: 0,
          columns: ["schedule_id", "started_at"],
        }),
        JSON.stringify({
          name: "script_runs_by_time",
          unique: 0,
          columns: ["started_at"],
        }),
      ]),
    );
  });

  test("a database from a server before Drizzle keeps its tables and records the baseline", () => {
    const existing = databaseFile(fixture("legacy-store-schema.sql"));
    const db = new Database(existing);
    db.run(
      "INSERT INTO agents (id,name,avatar,description,instructions,provider,model,enabled,tools,skills,mcp_servers,created_at,updated_at) VALUES ('a','A','','','','p','m',1,'[]','[]','[]','t','t')",
    );
    db.run(
      "INSERT INTO schedules (id,agent_id,name,prompt,timezone,enabled,created_at) VALUES ('s','a','Task','Hello','UTC',1,'t')",
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
    expect(
      reopened
        .query(
          "SELECT kind, command, timeout_seconds, notify, prompt FROM schedules",
        )
        .all(),
    ).toEqual([
      {
        kind: "prompt",
        command: null,
        timeout_seconds: 600,
        notify: 1,
        prompt: "Hello",
      },
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

  test("adding password managers keeps credentials and their use log", () => {
    // Rebuilding agent_credentials inside the migration's transaction would cascade into credential_uses.
    const before = mkdtempSync("/tmp/crumble-migrations-");
    dirs.push(before);

    for (const name of readdirSync(migrationsFolder("store")))
      if (name < "20261029092910_password_managers")
        cpSync(join(migrationsFolder("store"), name), join(before, name), {
          recursive: true,
        });

    const file = databaseFile();
    Effect.runSync(migrateFile(file, before));

    const db = new Database(file);
    db.run(`INSERT INTO agents (id,name,avatar,description,instructions,provider,model,enabled,tools,skills,mcp_servers,created_at,updated_at) VALUES ('a','A','','','','p','m',1,'[]','[]','[]','t','t');
      INSERT INTO agent_credentials (agent_id,name,hosts,value,placeholder,created_at,updated_at) VALUES ('a','TOKEN','[]','sealed','ph','t','t');
      INSERT INTO credential_uses (agent_id,name,at,method,host,path,status) VALUES ('a','TOKEN','t','GET','api.example.com','/',200);
      INSERT INTO credentials (key,value) VALUES ('mcp:s','sealed');
      INSERT INTO provider_credentials (provider,type,value) VALUES ('openai','api_key','sealed');`);
    db.close();

    migrateStore(file);

    const migrated = new Database(file, { readonly: true });
    expect(
      migrated
        .query("SELECT name, value, reference FROM agent_credentials")
        .all(),
    ).toEqual([{ name: "TOKEN", value: "sealed", reference: null }]);
    expect(
      migrated.query("SELECT name, host, status FROM credential_uses").all(),
    ).toEqual([{ name: "TOKEN", host: "api.example.com", status: 200 }]);
    expect(migrated.query("SELECT key, value FROM credentials").all()).toEqual([
      { key: "mcp:s", value: "sealed" },
    ]);
    expect(
      migrated.query("SELECT provider, value FROM provider_credentials").all(),
    ).toEqual([{ provider: "openai", value: "sealed" }]);
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  });

  test("migrating again changes nothing", () => {
    const file = databaseFile();
    migrateStore(file);
    const before = schemaOf(file);
    const migrations = migrationsOf(file);

    migrateStore(file);
    expect(schemaOf(file)).toEqual(before);
    expect(migrationsOf(file)).toEqual(migrations);
  });

  test("adding gateway receipts preserves existing bot executions and records delivery progress across reopen", () => {
    const before = mkdtempSync("/tmp/crumble-before-gateway-");
    dirs.push(before);

    for (const name of readdirSync(migrationsFolder("store")))
      if (name < "20261031191531_aromatic_karen_page")
        cpSync(join(migrationsFolder("store"), name), join(before, name), {
          recursive: true,
        });

    const file = databaseFile();
    Effect.runSync(migrateFile(file, before));
    const db = new Database(file);
    db.run(`INSERT INTO agents (id,name,avatar,description,instructions,provider,model,enabled,tools,skills,mcp_servers,created_at,updated_at) VALUES ('a','A','','','','p','m',1,'[]','[]','[]','t','t');
      INSERT INTO conversations (id,agent_id,title,created_at,updated_at) VALUES ('c','a','Chat','t','t');
      INSERT INTO executions (id,agent_id,conversation_id,submission_id,request_id,prompt,status,created_at,updated_at) VALUES ('e','a','c','s','r','Hello','done','t','t');`);
    expect(
      db
        .query("SELECT name FROM sqlite_master WHERE name = 'gateway_receipts'")
        .all(),
    ).toEqual([]);
    db.close();

    migrateStore(file);
    const upgraded = new Database(file);
    expect(
      upgraded
        .query("SELECT id,submission_id,request_id,prompt FROM executions")
        .all(),
    ).toEqual([
      { id: "e", submission_id: "s", request_id: "r", prompt: "Hello" },
    ]);
    upgraded.run(
      `INSERT INTO gateway_receipts (adapter_id,message_id,channel_id,sender_id,is_direct_message,bot_id,request_id,text,execution_id,chunks,sent,state) VALUES ('platform','message','channel','owner',0,'a','r','Hello','e','["answer"]','["external-message"]','done')`,
    );
    upgraded.close();

    migrateStore(file);
    const reopened = new Database(file, { readonly: true });
    expect(
      reopened
        .query(
          "SELECT bot_id,execution_id,chunks,sent,state FROM gateway_receipts",
        )
        .all(),
    ).toEqual([
      {
        bot_id: "a",
        execution_id: "e",
        chunks: '["answer"]',
        sent: '["external-message"]',
        state: "done",
      },
    ]);
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
    reopened.close();
  });

  test("gateway retention migration backfills reply mappings before scrubbing completed payloads", () => {
    const before = mkdtempSync("/tmp/crumble-before-gateway-retention-");
    dirs.push(before);

    for (const name of readdirSync(migrationsFolder("store")))
      if (name < "20261031194829_futuristic_flatman")
        cpSync(join(migrationsFolder("store"), name), join(before, name), {
          recursive: true,
        });

    const file = databaseFile();
    Effect.runSync(migrateFile(file, before));
    const original = new Database(file);
    original.run(`INSERT INTO gateway_receipts (adapter_id,message_id,channel_id,sender_id,is_direct_message,bot_id,request_id,text,execution_id,chunks,sent,state)
      VALUES ('platform','finished','channel','owner',0,'a','original-finished-request','private input','execution','["private output"]','["sent-finished"]','done'),
      ('platform','pending','channel','owner',0,'b','original-pending-request','keep input','pending-execution','["first","second"]','["sent-pending"]','pending');`);
    original.close();

    migrateStore(file);
    const db = new Database(file, { readonly: true });
    expect(
      db
        .query(
          "SELECT message_id,request_id,text,chunks,sent,state,attempt_count,next_attempt_at,failed_at FROM gateway_receipts ORDER BY message_id",
        )
        .all(),
    ).toEqual([
      {
        message_id: "finished",
        request_id: "original-finished-request",
        text: "",
        chunks: null,
        sent: "[]",
        state: "done",
        attempt_count: 0,
        next_attempt_at: null,
        failed_at: null,
      },
      {
        message_id: "pending",
        request_id: "original-pending-request",
        text: "keep input",
        chunks: '["first","second"]',
        sent: '["sent-pending"]',
        state: "pending",
        attempt_count: 0,
        next_attempt_at: null,
        failed_at: null,
      },
    ]);
    expect(
      db
        .query(
          "SELECT COUNT(*) AS n FROM gateway_receipts WHERE created_at > 0 AND expires_at = created_at + 86400000 AND (state = 'pending' AND finished_at IS NULL OR state = 'done' AND finished_at = created_at)",
        )
        .get(),
    ).toEqual({ n: 2 });
    expect(
      db
        .query(
          "SELECT adapter_id,channel_id,external_message_id,receipt_message_id,bot_id,expires_at IS NULL AS pending FROM gateway_sent_messages ORDER BY external_message_id",
        )
        .all(),
    ).toEqual([
      {
        adapter_id: "platform",
        channel_id: "channel",
        external_message_id: "sent-finished",
        receipt_message_id: "finished",
        bot_id: "a",
        pending: 0,
      },
      {
        adapter_id: "platform",
        channel_id: "channel",
        external_message_id: "sent-pending",
        receipt_message_id: "pending",
        bot_id: "b",
        pending: 1,
      },
    ]);
    expect(
      db
        .query(
          "SELECT COUNT(*) AS n FROM gateway_sent_messages s JOIN gateway_receipts r ON s.adapter_id = r.adapter_id AND s.receipt_message_id = r.message_id WHERE s.expires_at = r.finished_at + 2592000000",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    migrateStore(file);
    const reopened = new Database(file, { readonly: true });
    expect(
      reopened.query("SELECT COUNT(*) AS n FROM gateway_sent_messages").get(),
    ).toEqual({ n: 2 });
    reopened.close();
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
