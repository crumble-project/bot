import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import {
  CURRENT_SQLITE_SCHEMA_VERSION,
  SQLITE_MIGRATIONS,
} from "@earendil-works/pi-durable/storage/sqlite";
import { documentIdOf, formatEntryId } from "../shared/entry-ids";

const LocalId = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

const Segment = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

const PrivateHistory = Schema.Struct({
  agentId: Segment,
  conversations: Schema.Array(LocalId),
  tasks: Schema.Array(LocalId),
  entries: Schema.Array(LocalId),
  submissions: Schema.Array(LocalId),
  documents: Schema.Array(LocalId),
});

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  privateHistories: Schema.Array(PrivateHistory),
  conversations: Schema.Array(Schema.String),
  executions: Schema.Array(Schema.String),
  hashes: Schema.Array(Hash),
  groupFiles: Schema.Array(
    Schema.String.check(Schema.isPattern(/^[^/\\]+\.sqlite(?:-(?:wal|shm))?$/)),
  ),
});

type Manifest = typeof Manifest.Type;

type PrivateHistory = typeof PrivateHistory.Type;

function safePath(root: string, ...parts: Array<string>) {
  let path = root;

  for (const part of ["", ...parts]) {
    path = join(path, part);
    const stat = lstatSync(path, { throwIfNoEntry: false });

    if (stat?.isSymbolicLink()) {
      throw new Error(`Group chat cleanup refuses symlink: ${path}`);
    }
  }

  return path;
}

function existingDatabase(
  root: string,
  parts: Array<string>,
  readonly: boolean,
) {
  const path = safePath(root, ...parts);

  if (!lstatSync(path, { throwIfNoEntry: false })) {
    return;
  }
  safePath(root, ...parts.slice(0, -1), `${parts.at(-1)}-wal`);
  safePath(root, ...parts.slice(0, -1), `${parts.at(-1)}-shm`);
  // Cold WAL databases may need writable sidecars even for an inventory-only connection.
  const db = new Database(path, { create: false, strict: true });
  db.run(readonly ? "PRAGMA query_only = ON" : "PRAGMA foreign_keys = ON");

  return db;
}

function hasColumns(db: Database, table: string, ...columns: Array<string>) {
  const found = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all();

  if (!found.length) {
    return false;
  }

  return columns.every((column) => found.some((row) => row.name === column));
}

function ids(db: Database, sql: string): Array<number> {
  return db
    .query<{ id: number }, []>(sql)
    .all()
    .map((row) => row.id);
}

function validatePi(db: Database) {
  if (
    CURRENT_SQLITE_SCHEMA_VERSION !== 2 ||
    !hasColumns(db, "durable_schema", "version")
  ) {
    throw new Error(
      "Unsupported Pi schema for group chat cleanup (expected Pi Durable 1.4.0 / schema 2)",
    );
  }

  const version = db
    .query<{ version: number }, []>(
      "SELECT max(version) AS version FROM durable_schema",
    )
    .get();

  if (version?.version !== 2) {
    throw new Error(
      "Unsupported Pi schema for group chat cleanup (expected schema 2); upgrade with a compatible server",
    );
  }
  const expected = new Database(":memory:");

  try {
    for (const migration of SQLITE_MIGRATIONS) {
      for (const statement of migration.statements) {
        expected.run(statement);
      }
    }

    for (const table of [
      "durable_metadata",
      "record_ids",
      "conversations",
      "tasks",
      "entries",
      "submissions",
      "documents",
      "document_revisions",
    ]) {
      const sql = `PRAGMA table_info(${table})`;

      const definition = (database: Database) =>
        database
          .query<{ sql: string }, [string]>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(table)
          ?.sql.replaceAll(/\s+/g, " ")
          .trim();

      if (
        JSON.stringify(db.query(sql).all()) !==
          JSON.stringify(expected.query(sql).all()) ||
        definition(db) !== definition(expected)
      ) {
        throw new Error(`Unsupported Pi ${table} shape for group chat cleanup`);
      }
    }

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'durable_schema' ORDER BY name",
      )
      .all();

    if (
      JSON.stringify(tables) !==
      JSON.stringify(
        expected
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all(),
      )
    ) {
      throw new Error("Unsupported Pi tables for group chat cleanup");
    }

    if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'trigger'").get()) {
      throw new Error("Unsupported Pi triggers for group chat cleanup");
    }
  } finally {
    expected.close();
  }
}

function guardInheritance(db: Database, selected: ReadonlySet<number>) {
  const rows = db
    .query<{ id: number; parent: number | null }, []>(
      "SELECT id, json_extract(record, '$.parent.conversationId') AS parent FROM conversations",
    )
    .all();

  for (const row of rows) {
    if (
      !selected.has(row.id) &&
      row.parent !== null &&
      selected.has(row.parent)
    ) {
      throw new Error(
        `Cannot remove group history: retained Pi conversation ${row.id} inherits from group conversation ${row.parent}. Restore a backup and resolve the inherited history before upgrading.`,
      );
    }
  }
}

type ReviewInventory = {
  path: string;
  executions: ReadonlySet<string>;
  pending: ReadonlySet<string>;
};

async function inventoryReviewConversations(
  db: Database,
  agentId: string,
  reviews: ReviewInventory,
) {
  const selected = new Set(reviews.pending);

  const documents = ids(
    db,
    "SELECT id FROM documents WHERE kind = json_quote('crumble.review-conversation')",
  );

  if (!documents.length) {
    return selected;
  }

  const storage = await openNodeSqliteStorage(reviews.path);

  try {
    for (const id of documents) {
      const document = await storage.document(
        documentIdOf(id),
        "current",
        BACKGROUND_CONTEXT,
      );

      if (document?.record.scope.kind !== "conversation") {
        continue;
      }

      const review = Schema.decodeUnknownSync(
        Schema.Struct({
          executionId: Schema.NullOr(Schema.String),
          groupId: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      )(document.value);

      if (
        (review.executionId !== null &&
          reviews.executions.has(review.executionId)) ||
        (review.groupId !== null && review.groupId !== undefined)
      ) {
        selected.add(
          formatEntryId(agentId, document.record.scope.conversationId),
        );
      }
    }
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }

  return selected;
}

async function inventoryPi(
  db: Database,
  agentId: string,
  reviews?: ReviewInventory,
): Promise<PrivateHistory> {
  validatePi(db);

  const tasks = new Set(
    ids(
      db,
      "SELECT id FROM tasks WHERE kind = json_quote('crumble.group-anchor')",
    ),
  );

  const conversations = new Set<number>();

  if (reviews) {
    const selected = await inventoryReviewConversations(db, agentId, reviews);

    for (const row of db
      .query<{ id: number; anchor: number | null }, []>(
        "SELECT c.id, t.id AS anchor FROM conversations c LEFT JOIN tasks t ON t.id = c.owner_task_id AND t.kind = json_quote('crumble.review-anchor')",
      )
      .all()
      .filter((row) => selected.has(formatEntryId(agentId, row.id)))) {
      conversations.add(row.id);

      if (row.anchor !== null) {
        tasks.add(row.anchor);
      }
    }
  }

  const taskRows = db
    .query<{ id: number; conversation_id: number; owner: number | null }, []>(
      "SELECT id, conversation_id, json_extract(record, '$.owner') AS owner FROM tasks",
    )
    .all();

  const conversationRows = db
    .query<
      {
        id: number;
        owner_task_id: number | null;
        owner_conversation_id: number | null;
      },
      []
    >("SELECT id, owner_task_id, owner_conversation_id FROM conversations")
    .all();

  let changed = true;

  while (changed) {
    const size = tasks.size + conversations.size;

    for (const row of conversationRows) {
      if (
        (row.owner_task_id !== null && tasks.has(row.owner_task_id)) ||
        (row.owner_conversation_id !== null &&
          conversations.has(row.owner_conversation_id))
      ) {
        conversations.add(row.id);
      }
    }

    for (const row of taskRows) {
      if (
        conversations.has(row.conversation_id) ||
        (row.owner !== null && tasks.has(row.owner))
      ) {
        tasks.add(row.id);
      }
    }
    changed = tasks.size + conversations.size !== size;
  }

  if (conversations.has(1)) {
    throw new Error(
      "Group chat cleanup refuses to remove the Pi root conversation",
    );
  }
  guardInheritance(db, conversations);

  const selectedRows = (table: string) =>
    db
      .query<{ id: number; conversation_id: number }, []>(
        `SELECT id, conversation_id FROM ${table}`,
      )
      .all()
      .filter((row) => conversations.has(row.conversation_id))
      .map((row) => row.id);

  const documents = db
    .query<{ id: number; scope_kind: string; owner_id: number }, []>(
      "SELECT id, scope_kind, owner_id FROM documents",
    )
    .all()
    .filter(
      (row) =>
        (row.scope_kind === "conversation" &&
          conversations.has(row.owner_id)) ||
        (row.scope_kind === "task" && tasks.has(row.owner_id)),
    )
    .map((row) => row.id);

  return {
    agentId,
    conversations: [...conversations],
    tasks: [...tasks],
    entries: selectedRows("entries"),
    submissions: selectedRows("submissions"),
    documents,
  };
}

function inventoryReviewIds(
  store: Database,
  conversations: Set<string>,
  executions: Set<string>,
) {
  if (hasColumns(store, "pending_reviews", "execution_id", "conversation_id")) {
    for (const row of store
      .query<{ execution_id: string; conversation_id: string }, []>(
        "SELECT execution_id, conversation_id FROM pending_reviews",
      )
      .all()) {
      if (conversations.has(row.conversation_id)) {
        executions.add(row.execution_id);
      }
    }
  }

  if (hasColumns(store, "review_results", "execution_id")) {
    for (const row of store
      .query<{ execution_id: string }, []>(
        "SELECT execution_id FROM review_results",
      )
      .all()) {
      const parts = row.execution_id.split(":");

      const kind = parts[0];

      if (
        parts.length === 4 &&
        kind !== undefined &&
        kind.endsWith("-job") &&
        conversations.has(`${parts[1]}:${parts[2]}`)
      ) {
        executions.add(row.execution_id);
      }
    }
  }
}

function inventoryStore(store: Database, conversations: Set<string>) {
  const executions = new Set<string>();
  const hashes: Array<string> = [];

  if (hasColumns(store, "group_members", "conversation_id")) {
    for (const row of store
      .query<{ conversation_id: string | null }, []>(
        "SELECT conversation_id FROM group_members",
      )
      .all()) {
      if (row.conversation_id) {
        conversations.add(row.conversation_id);
      }
    }
  }

  if (hasColumns(store, "group_turns", "execution_id")) {
    for (const row of store
      .query<{ execution_id: string }, []>(
        "SELECT execution_id FROM group_turns",
      )
      .all()) {
      executions.add(row.execution_id);
    }
  }

  if (hasColumns(store, "executions", "id", "conversation_id")) {
    for (const row of store
      .query<{ id: string; conversation_id: string }, []>(
        "SELECT id, conversation_id FROM executions",
      )
      .all()) {
      if (conversations.has(row.conversation_id)) {
        executions.add(row.id);
      }
    }
  }

  inventoryReviewIds(store, conversations, executions);

  if (hasColumns(store, "library_files", "hash", "group_id", "agent_id")) {
    for (const row of store
      .query<{ hash: string }, []>(
        "SELECT DISTINCT hash FROM library_files WHERE group_id IS NOT NULL",
      )
      .all()) {
      hashes.push(Schema.decodeUnknownSync(Hash)(row.hash));
    }
  }

  const reviews = hasColumns(
    store,
    "pending_reviews",
    "execution_id",
    "agent_id",
    "conversation_id",
  )
    ? store
        .query<
          { agent_id: string; conversation_id: string; execution_id: string },
          []
        >("SELECT agent_id, conversation_id, execution_id FROM pending_reviews")
        .all()
        .filter((row) => executions.has(row.execution_id))
    : [];

  return { executions: [...executions], hashes, reviews };
}

async function inventory(root: string): Promise<Manifest> {
  const privateHistories: Array<PrivateHistory> = [];
  const agents = safePath(root, "agents");

  if (lstatSync(agents, { throwIfNoEntry: false })) {
    for (const file of readdirSync(agents)) {
      if (!file.endsWith(".sqlite")) {
        continue;
      }
      const agentId = Schema.decodeUnknownSync(Segment)(file.slice(0, -7));
      const db = existingDatabase(root, ["agents", file], true);

      if (!db) {
        continue;
      }

      try {
        privateHistories.push(await inventoryPi(db, agentId));
      } finally {
        db.close();
      }
    }
  }

  const conversations = new Set(
    privateHistories.flatMap((history) =>
      history.conversations.map((id) => formatEntryId(history.agentId, id)),
    ),
  );

  const store = existingDatabase(root, ["store.sqlite"], true);

  let stored: ReturnType<typeof inventoryStore> = {
    executions: [],
    hashes: [],
    reviews: [],
  };

  try {
    if (store) {
      stored = inventoryStore(store, conversations);
    }
  } finally {
    store?.close();
  }

  for (const [index, history] of privateHistories.entries()) {
    const path = safePath(root, "agents", `${history.agentId}.sqlite`);

    const db = existingDatabase(
      root,
      ["agents", `${history.agentId}.sqlite`],
      true,
    );

    if (!db) {
      continue;
    }

    try {
      privateHistories[index] = await inventoryPi(db, history.agentId, {
        path,
        executions: new Set(stored.executions),
        pending: new Set(
          stored.reviews
            .filter((row) => row.agent_id === history.agentId)
            .map((row) => row.conversation_id),
        ),
      });

      for (const id of privateHistories[index].conversations) {
        conversations.add(formatEntryId(history.agentId, id));
      }
    } finally {
      db.close();
    }
  }

  // Reviews can have their own executions and pending rows, too.
  const expandedStore = existingDatabase(root, ["store.sqlite"], true);

  try {
    if (expandedStore) {
      stored = inventoryStore(expandedStore, conversations);
    }
  } finally {
    expandedStore?.close();
  }

  const groups = safePath(root, "groups");

  const groupFiles = lstatSync(groups, { throwIfNoEntry: false })
    ? readdirSync(groups).filter((file) =>
        /\.sqlite(?:-(?:wal|shm))?$/.test(file),
      )
    : [];

  for (const file of groupFiles) {
    safePath(root, "groups", file);
  }

  return Schema.decodeUnknownSync(Manifest)({
    version: 1,
    privateHistories,
    conversations: [...conversations],
    executions: stored.executions,
    hashes: stored.hashes,
    groupFiles,
  });
}

function persist(root: string, manifest: Manifest) {
  const temporary = safePath(root, "group-chat-removal.json.tmp");
  const file = openSync(temporary, "w", 0o600);

  try {
    writeFileSync(file, JSON.stringify(manifest));
    fsyncSync(file);
  } finally {
    closeSync(file);
  }

  renameSync(temporary, safePath(root, "group-chat-removal.json"));
  const directory = openSync(root, "r");

  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function removeFile(root: string, ...parts: Array<string>) {
  const path = safePath(root, ...parts);

  if (lstatSync(path, { throwIfNoEntry: false })) {
    unlinkSync(path);
  }
}

function deleteIds(
  db: Database,
  table: string,
  column: string,
  selected: ReadonlyArray<string | number>,
) {
  if (!hasColumns(db, table, column)) {
    return;
  }
  const statement = db.query(`DELETE FROM ${table} WHERE ${column} = ?`);

  for (const id of selected) {
    statement.run(id);
  }
}

function purgePi(root: string, history: PrivateHistory) {
  if (history.conversations.includes(1)) {
    throw new Error(
      "Group chat cleanup refuses to remove the Pi root/direct conversation, including on manifest replay",
    );
  }

  const db = existingDatabase(
    root,
    ["agents", `${history.agentId}.sqlite`],
    false,
  );

  if (!db) {
    return;
  }

  try {
    validatePi(db);
    guardInheritance(db, new Set(history.conversations));
    db.transaction(() => {
      deleteIds(db, "document_revisions", "document_id", history.documents);

      for (const [table, selected] of [
        ["documents", history.documents],
        ["entries", history.entries],
        ["submissions", history.submissions],
        ["tasks", history.tasks],
        ["conversations", history.conversations],
      ] as const) {
        deleteIds(db, table, "id", selected);
        deleteIds(db, "record_ids", "id", selected);
      }
    })();
  } finally {
    db.close();
  }
}

function purgePush(root: string) {
  const db = existingDatabase(root, ["push.sqlite"], false);

  if (!db) {
    return;
  }

  try {
    db.transaction(() => {
      const events = new Set<string>();

      if (hasColumns(db, "reply_associations", "event_id", "chat_kind")) {
        for (const row of db
          .query<{ event_id: string }, []>(
            "SELECT event_id FROM reply_associations WHERE chat_kind = 'group'",
          )
          .all()) {
          events.add(row.event_id);
        }
      }

      if (hasColumns(db, "push_outbox", "id", "event_id", "event_json")) {
        for (const row of db
          .query<{ id: string; event_id: string; group_event: number }, []>(
            `SELECT id, event_id, EXISTS (SELECT 1 FROM json_tree(event_json) WHERE (key = 'groupId' AND type != 'null') OR (key IN ('origin', 'kind') AND value = 'group')) AS group_event FROM push_outbox`,
          )
          .all()) {
          if (!events.has(row.event_id) && !row.group_event) {
            continue;
          }
          deleteIds(db, "reply_associations", "event_id", [row.event_id]);
          deleteIds(db, "push_delivery", "outbox_id", [row.id]);
          deleteIds(db, "push_outbox", "id", [row.id]);
        }
      }

      for (const table of ["chat_views", "reply_associations"]) {
        if (hasColumns(db, table, "chat_kind")) {
          db.run(`DELETE FROM ${table} WHERE chat_kind = 'group'`);
        }
      }
    })();
  } finally {
    db.close();
  }
}

function normalizeProvenance(db: Database, manifest: Manifest) {
  if (hasColumns(db, "memories", "source")) {
    db.run(
      "UPDATE memories SET source = NULL WHERE json_extract(source, '$.kind') = 'group'",
    );
  }

  if (hasColumns(db, "skills", "source_execution_id")) {
    for (const id of manifest.executions) {
      db.query(
        "UPDATE skills SET source_execution_id = NULL WHERE source_execution_id = ?",
      ).run(id);
    }
  }

  if (
    !hasColumns(db, "learned_changes", "source", "before_state", "after_state")
  ) {
    return;
  }
  db.run(
    "UPDATE learned_changes SET source = json_remove(source, '$.groupId') WHERE source IS NOT NULL",
  );

  for (const [key, selected] of [
    ["executionId", manifest.executions],
    ["conversationId", manifest.conversations],
  ] as const) {
    for (const id of selected) {
      db.query(
        `UPDATE learned_changes SET source = json_remove(source, '$.${key}') WHERE json_extract(source, '$.${key}') = ?`,
      ).run(id);
    }
  }

  for (const column of ["before_state", "after_state"]) {
    db.run(
      `UPDATE learned_changes SET ${column} = json_set(${column}, '$.source', NULL) WHERE target = 'memory' AND json_extract(${column}, '$.source.kind') = 'group'`,
    );

    for (const id of manifest.executions) {
      db.query(
        `UPDATE learned_changes SET ${column} = json_set(${column}, '$.sourceExecutionId', NULL) WHERE target = 'skill' AND json_extract(${column}, '$.sourceExecutionId') = ?`,
      ).run(id);
    }
  }
}

function purgeStore(root: string, manifest: Manifest) {
  const db = existingDatabase(root, ["store.sqlite"], false);

  if (!db) {
    return;
  }

  try {
    if (hasColumns(db, "library_files", "group_id", "agent_id", "hash")) {
      for (const hash of manifest.hashes) {
        if (
          db
            .query(
              "SELECT 1 FROM library_files WHERE agent_id IS NOT NULL AND hash = ?",
            )
            .get(hash)
        ) {
          continue;
        }

        for (const suffix of ["", ".txt", ".pdf.txt"]) {
          removeFile(root, "files", `${hash}${suffix}`);
        }
      }
    }

    db.transaction(() => {
      normalizeProvenance(db, manifest);

      for (const table of ["library_files", "deleted_library_files"]) {
        if (hasColumns(db, table, "group_id")) {
          db.run(`DELETE FROM ${table} WHERE group_id IS NOT NULL`);
        }
      }

      for (const table of ["group_turns", "group_members", "group_chats"]) {
        if (hasColumns(db, table)) {
          db.run(`DELETE FROM ${table}`);
        }
      }

      for (const table of ["pending_reviews", "review_results"]) {
        deleteIds(db, table, "execution_id", manifest.executions);
      }
      deleteIds(
        db,
        "pending_reviews",
        "conversation_id",
        manifest.conversations,
      );
      deleteIds(db, "executions", "id", manifest.executions);
      deleteIds(db, "conversations", "id", manifest.conversations);
    })();
  } finally {
    db.close();
  }
}

function completedUpgrade(root: string) {
  const store = existingDatabase(root, ["store.sqlite"], true);

  if (!store) {
    return false;
  }

  try {
    return (
      hasColumns(store, "__drizzle_migrations", "name") &&
      !!store
        .query("SELECT 1 FROM __drizzle_migrations WHERE name = ?")
        .get("20261122205418_remove_group_chats")
    );
  } finally {
    store.close();
  }
}

export async function removeLegacyGroupChats(
  accountDirectory: string,
): Promise<void> {
  const root = resolve(accountDirectory);

  if (!lstatSync(safePath(root), { throwIfNoEntry: false })) {
    return;
  }
  const path = safePath(root, "group-chat-removal.json");

  if (!lstatSync(path, { throwIfNoEntry: false }) && completedUpgrade(root)) {
    return;
  }

  const manifest = lstatSync(path, { throwIfNoEntry: false })
    ? Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
        readFileSync(path, "utf8"),
      )
    : await inventory(root);

  const store = existingDatabase(root, ["store.sqlite"], true);

  try {
    if (store && hasColumns(store, "conversations", "id", "chat")) {
      for (const id of new Set([
        ...manifest.conversations,
        ...manifest.privateHistories.flatMap((history) =>
          history.conversations.map((local) =>
            formatEntryId(history.agentId, local),
          ),
        ),
      ])) {
        if (
          store
            .query("SELECT 1 FROM conversations WHERE id = ? AND chat = 1")
            .get(id)
        ) {
          throw new Error(
            `Group chat cleanup refuses to remove direct conversation ${id}`,
          );
        }
      }
    }
  } finally {
    store?.close();
  }

  for (const history of manifest.privateHistories) {
    if (history.conversations.includes(1)) {
      throw new Error(
        "Group chat cleanup refuses to remove the Pi root/direct conversation, including on manifest replay",
      );
    }
  }
  persist(root, manifest);

  for (const history of manifest.privateHistories) {
    purgePi(root, history);
  }

  for (const file of manifest.groupFiles) {
    removeFile(root, "groups", file);
  }
  purgePush(root);
  purgeStore(root, manifest);
  removeFile(root, "group-chat-removal.json");
}
