import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { listTables } from "./database";

// Columns that servers before Drizzle added to existing tables at startup, in the order they were introduced.
// Tables a database lacks entirely come from the baseline migration instead, which creates them whole.
const addedColumns: ReadonlyArray<readonly [string, string, string]> = [
  ["agents", "delegates", "TEXT NOT NULL DEFAULT '[]'"],
  ["agents", "inference", "TEXT NOT NULL DEFAULT '{}'"],
  ["agents", "shared_skills", "TEXT NOT NULL DEFAULT '[]'"],
  ["agents", "desktop_model", "TEXT"],
  ["agents", "review_model", "TEXT"],
  ["agents", "review", "TEXT"],
  ["agents", "shared_memory", "INTEGER NOT NULL DEFAULT 0"],
  ["memories", "source", "TEXT"],
  ["mcp_servers", "agent_id", "TEXT REFERENCES agents(id) ON DELETE CASCADE"],
  ["mcp_servers", "oauth_client_id", "TEXT"],
  ["conversations", "archived", "INTEGER NOT NULL DEFAULT 0"],
  ["schedules", "created_by_agent_id", "TEXT"],
  ["group_chats", "bot_turns", "INTEGER NOT NULL DEFAULT 0"],
  ["group_chats", "paused", "INTEGER NOT NULL DEFAULT 0"],
  ["group_chats", "awaiting_answers", "TEXT NOT NULL DEFAULT '{}'"],
  ["group_members", "conversation_id", "TEXT"],
  ["group_members", "summary", "TEXT"],
  ["group_members", "cursor", "INTEGER NOT NULL DEFAULT 0"],
  ["group_members", "pending", "INTEGER NOT NULL DEFAULT 0"],
  ["group_members", "pending_bot_started", "INTEGER NOT NULL DEFAULT 0"],
  ["executions", "prompt", "TEXT"],
  ["executions", "reply_to", "TEXT"],
  ["executions", "attachments", "TEXT"],
  ["executions", "attachments_digest", "TEXT"],
  ["skills", "agent_id", "TEXT REFERENCES agents(id) ON DELETE CASCADE"],
  ["skills", "description", "TEXT NOT NULL DEFAULT ''"],
  ["skills", "created_by", "TEXT NOT NULL DEFAULT 'owner'"],
  ["skills", "source_execution_id", "TEXT"],
  ["skills", "use_count", "INTEGER NOT NULL DEFAULT 0"],
  ["skills", "last_used_at", "TEXT"],
  ["skills", "state", "TEXT NOT NULL DEFAULT 'active'"],
  ["skills", "pinned", "INTEGER NOT NULL DEFAULT 0"],
];

const tableInfo = Schema.Array(
  Schema.Struct({ name: Schema.String, notnull: Schema.Number }),
);

/**
 * Brings a product database created before Drizzle to the baseline migration's schema. Its statements are the ones
 * those servers ran at startup, frozen here; new schema changes are Drizzle migrations.
 */
export const upgradeLegacyStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* listTables;

  const columns = Effect.fnUntraced(function* (table: string) {
    return yield* Schema.decodeUnknownEffect(tableInfo)(
      yield* sql.unsafe(`PRAGMA table_info(${table})`),
    );
  });

  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (tables.has("agents")) {
        const agentColumns = yield* columns("agents");

        if (agentColumns.some((column) => column.name === "folder"))
          yield* sql.unsafe("ALTER TABLE agents DROP COLUMN folder");
      }

      // Shared memories have no bot, and SQLite cannot drop NOT NULL in place.
      if (tables.has("memories")) {
        const memoryColumns = yield* columns("memories");

        if (
          memoryColumns.find((column) => column.name === "agent_id")?.notnull
        ) {
          yield* sql.unsafe(
            "CREATE TABLE memories_next (id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
          );
          yield* sql.unsafe(
            "INSERT INTO memories_next SELECT id, agent_id, content, created_at, updated_at FROM memories",
          );
          yield* sql.unsafe("DROP TABLE memories");
          yield* sql.unsafe("ALTER TABLE memories_next RENAME TO memories");
        }
      }

      for (const [table, column, definition] of addedColumns) {
        if (!tables.has(table)) continue;

        const existing = yield* columns(table);

        if (!existing.some((each) => each.name === column))
          yield* sql.unsafe(
            `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
          );
      }
    }),
  );
});
