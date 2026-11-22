import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect } from "effect";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../test/support/store";
import { agentInput } from "../contract/agents";
import { AgentRuntime } from "../bots/runtime";
import { runtimeCallbacks } from "../../test/support/runtime-callbacks";
import { defineAnchorTask } from "../shared/anchor-task";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { migrateFile, migrationsFolder } from "../shared/database";
import { removeLegacyGroupChats } from "./group-chat-upgrade";
import { openReviewConversation, ReviewAnchor } from "../learning/review-kind";
import { defineDoc } from "@earendil-works/pi-durable";

const directories: string[] = [];
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "group-chat-upgrade-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function privateHistory(directory: string, agentId: string) {
  mkdirSync(join(directory, "agents"), { recursive: true });
  const path = join(directory, "agents", `${agentId}.sqlite`);
  const storage = await openNodeSqliteStorage(path);
  await storage.close(BACKGROUND_CONTEXT);
  const db = new Database(path);
  const register = (id: number, kind: string) =>
    db.query("INSERT INTO record_ids VALUES (?, ?)").run(id, kind);
  const conversation = (
    id: number,
    task: number | null = null,
    owner: number | null = null,
  ) => {
    register(id, "conversation");
    db.query("INSERT INTO conversations VALUES (?, ?, ?, ?)").run(
      id,
      owner,
      task,
      JSON.stringify({
        id,
        ...(task === null
          ? {}
          : { owner: { conversationId: owner, taskId: task } }),
      }),
    );
  };
  const task = (
    id: number,
    conversationId: number,
    kind: string,
    owner?: number,
  ) => {
    register(id, "task");
    const record = {
      id,
      conversationId,
      kind,
      version: 1,
      input: null,
      ...(owner === undefined ? {} : { owner }),
      state: {
        status: "terminal",
        outcome: { status: "completed", result: null },
      },
    };
    db.query("INSERT INTO tasks VALUES (?, ?, ?, 'terminal', 0, 0, ?)").run(
      id,
      conversationId,
      JSON.stringify(kind),
      JSON.stringify(record),
    );
  };
  const entry = (id: number, conversationId: number, content: string) => {
    register(id, "entry");
    db.query("INSERT INTO entries VALUES (?, ?, NULL, 10, ?)").run(
      id,
      conversationId,
      JSON.stringify({
        id,
        conversationId,
        kind: "message",
        data: { content },
      }),
    );
  };
  const document = (
    id: number,
    kind: string,
    scope: string,
    owner: number,
    retired = false,
  ) => {
    register(id, "document");
    db.query("INSERT INTO documents VALUES (?, ?, 0, ?, ?, ?, 10, ?, ?)").run(
      id,
      JSON.stringify(kind),
      JSON.stringify(""),
      scope,
      owner,
      retired ? 11 : null,
      JSON.stringify({
        id,
        kind,
        scope: {
          kind: scope,
          ...(scope === "conversation"
            ? { conversationId: owner }
            : scope === "task"
              ? { taskId: owner }
              : {}),
        },
        createdAt: 10,
        ...(retired ? { retiredAt: 11 } : {}),
      }),
    );
    db.query("INSERT INTO document_revisions VALUES (?, 10, 'base', 1, ?)").run(
      id,
      JSON.stringify({
        groupId:
          scope === "conversation" && owner === 3 ? "deleted-group" : null,
        content: "document sentinel",
      }),
    );
  };
  conversation(1);
  task(2, 1, "crumble.group-anchor");
  conversation(3, 2, 1);
  entry(4, 3, "private group transcript");
  task(5, 3, "generation");
  task(6, 3, "tool", 5);
  conversation(7, 6, 3);
  entry(8, 7, "nested private history");
  document(9, "crumble.group-conversation", "conversation", 3);
  document(10, "retired-document", "conversation", 7, true);
  document(11, "task-document", "task", 2);
  register(12, "submission");
  db.query("INSERT INTO submissions VALUES (12, 3, ?, 'done', ?)").run(
    JSON.stringify("private-input"),
    JSON.stringify({
      id: 12,
      conversationId: 3,
      type: "write",
      status: "done",
      entry: 4,
    }),
  );
  entry(20, 1, "direct chat sentinel");
  task(21, 1, "crumble.review-anchor");
  conversation(22, 21, 1);
  entry(23, 22, "unrelated review sentinel");
  task(24, 1, "crumble.outside-call-anchor");
  conversation(25, 24, 1);
  entry(26, 25, "outside call sentinel");
  document(27, "session-document", "session", 0);
  document(28, "root-document", "conversation", 1);
  document(29, "review-document", "task", 21);
  db.run("UPDATE durable_metadata SET next_id = '1000', next_seq = 100");
  db.close();
  return path;
}

async function fixture() {
  const directory = temporary();
  const store = new Store(directory);
  const agents = ["member", "former", "deleted"].map((id) =>
    store.createAgent(agentInput.parse({ name: id }), id),
  );
  for (const agent of agents) {
    for (const id of [1, 3, 7, 22, 25]) {
      store.createConversation(
        { agentId: agent.id, title: id === 1 ? "Direct" : "Private" },
        `${agent.id}:${id}`,
      );
      if (id === 3) store.archiveConversation(`${agent.id}:${id}`);
    }
    for (const id of [1, 3, 22, 25]) {
      store.createExecution(
        {
          agentId: agent.id,
          conversationId: `${agent.id}:${id}`,
          requestId: `request-${id}`,
          prompt: "sentinel",
          scheduleId: null,
          submissionId: null,
          status: "done",
          error: null,
        },
        `${agent.id}-execution-${id}`,
      );
      store.addPendingReview(
        `${agent.id}-execution-${id}`,
        agent.id,
        `${agent.id}:${id}`,
      );
    }
  }
  const source = {
    executionId: "former-execution-3",
    conversationId: "former:3",
    groupId: "deleted-group",
  };
  const memory = store.createMemory(
    {
      agentId: "former",
      content: "after",
      source: null,
    },
    "retained-memory",
  );
  const skill = store.createSkill(
    {
      agentId: "former",
      name: "learned",
      description: "retained",
      instructions: "Keep these instructions",
      documents: [],
      createdBy: "bot",
      sourceExecutionId: "former-execution-3",
    },
    "retained-skill",
    { actor: "bot", source },
  );
  store.close();
  const db = new Database(join(directory, "store.sqlite"));
  const legacy = readFileSync(
    new URL("../../test/fixtures/legacy-store-schema.sql", import.meta.url),
    "utf8",
  );
  for (const table of ["group_chats", "group_members", "group_turns"])
    db.run(
      legacy
        .split("\n")
        .find((line) => line.startsWith(`CREATE TABLE ${table} `))!,
    );
  db.run("DROP TABLE library_files; DROP TABLE deleted_library_files");
  for (const migration of [
    "20261111192433_file_library",
    "20261111195518_file_library_deleted",
    "20261112101421_library_file_descriptions",
  ])
    for (const statement of readFileSync(
      join(migrationsFolder("store"), migration, "migration.sql"),
      "utf8",
    ).split("--> statement-breakpoint"))
      db.run(statement);
  db.run(
    "DELETE FROM __drizzle_migrations WHERE name = '20261122205418_remove_group_chats'; INSERT INTO group_chats (id, name, created_at, updated_at) VALUES ('live-group', 'Legacy', 'now', 'now'); INSERT INTO group_members (group_id, agent_id, joined_at, conversation_id) VALUES ('live-group', 'member', 'now', 'member:3'); INSERT INTO group_turns VALUES ('member-execution-3', 'live-group', 'member', 1, 0, 'settled', 'now')",
  );
  const legacySource = {
    kind: "group",
    groupId: "deleted-group",
    name: "Old group",
  };
  db.query("UPDATE memories SET source = ? WHERE id = ?").run(
    JSON.stringify(legacySource),
    memory.id,
  );
  const legacyMemory = { ...memory, source: legacySource };
  db.run("UPDATE conversations SET chat = 1 WHERE id LIKE '%:1'");
  db.query(
    "INSERT INTO learned_changes (id, agent_id, actor, target, target_id, action, before_state, after_state, source, reverts_id, created_at) VALUES (?, 'former', 'bot', 'memory', ?, 'update', ?, ?, ?, NULL, ?)",
  ).run(
    "memory-change",
    memory.id,
    JSON.stringify({ ...legacyMemory, content: "before" }),
    JSON.stringify(legacyMemory),
    JSON.stringify(source),
    memory.createdAt,
  );
  db.query(
    "INSERT INTO learned_changes (id, agent_id, actor, target, target_id, action, before_state, after_state, source, reverts_id, created_at) VALUES ('older-revert', 'former', 'owner', 'memory', ?, 'revert', NULL, NULL, NULL, 'older-change', ?)",
  ).run(memory.id, memory.createdAt);
  for (const agent of agents)
    for (const id of [1, 3, 22, 25])
      db.query("INSERT INTO review_results VALUES (?, ?, '[]', ?)").run(
        `${agent.id}-execution-${id}`,
        agent.id,
        memory.createdAt,
      );
  db.run(
    "INSERT INTO pending_reviews VALUES ('coding-job:former:7:12', 'former', 'former:7', 'now'); INSERT INTO review_results VALUES ('coding-job:former:7:12', 'former', '[]', 'now'); INSERT INTO review_results VALUES ('coding-job:former:3:12', 'former', '[]', 'now')",
  );
  const exclusive = "a".repeat(64);
  const shared = "b".repeat(64);
  for (const [id, agent, group, hash] of [
    ["exclusive", null, "live-group", exclusive],
    ["group-shared", null, "live-group", shared],
    ["bot-shared", "former", null, shared],
  ])
    db.query(
      "INSERT INTO library_files (id, agent_id, group_id, name, mime_type, size, hash, text, created_at) VALUES (?, ?, ?, ?, 'application/pdf', 5, ?, 'extracted', ?)",
    ).run(id!, agent!, group!, `${id}.pdf`, hash!, memory.createdAt);
  db.run(
    "INSERT INTO deleted_library_files VALUES ('group-tombstone', NULL, 'live-group', 'old.pdf'); INSERT INTO deleted_library_files VALUES ('bot-tombstone', 'former', NULL, 'bot.pdf')",
  );
  db.close();
  mkdirSync(join(directory, "files"), { recursive: true });
  for (const hash of [exclusive, shared])
    for (const suffix of ["", ".txt", ".pdf.txt"])
      writeFileSync(
        join(directory, "files", `${hash}${suffix}`),
        `${hash}${suffix} sentinel`,
      );
  mkdirSync(join(directory, "groups"));
  for (const name of [
    "live-group.sqlite",
    "orphan.sqlite-wal",
    "orphan.sqlite-shm",
  ])
    writeFileSync(
      join(directory, "groups", name),
      "shared transcript sentinel",
    );
  for (const agent of agents) await privateHistory(directory, agent.id);
  await Effect.runPromise(
    migrateFile(join(directory, "push.sqlite"), migrationsFolder("push")),
  );
  const push = new Database(join(directory, "push.sqlite"));
  push.run(
    "INSERT INTO push_settings VALUES ('credentials', 'retained'); INSERT INTO push_devices VALUES ('device', 'ios', 'apns', 'disposable-token', 'sandbox', 'test', 1, 'now')",
  );
  for (const [id, kind, event] of [
    ["bot", "bot", { type: "reply", origin: "owner" }],
    ["associated", "group", { type: "reply" }],
    ["group-id", "bot", { type: "reply", groupId: "deleted-group" }],
    ["group-origin", "bot", { type: "reply", origin: "group" }],
    [
      "nested-group-origin",
      "bot",
      { type: "reply", origin: { kind: "group" } },
    ],
  ] as const) {
    push.query("INSERT INTO chat_views VALUES (?, ?, ?, 1)").run(id, kind, id);
    push
      .query(
        "INSERT INTO reply_associations VALUES (?, ?, ?, 'message', 'entry', '{}', 0)",
      )
      .run(id, kind, id);
    push
      .query("INSERT INTO push_outbox VALUES (?, ?, ?, 'now', 9999999999999)")
      .run(id, id, JSON.stringify(event));
    push
      .query("INSERT INTO push_delivery VALUES (?, 'device', 0, 0, 0)")
      .run(id);
  }
  push.close();
  return { directory, exclusive, shared, memory, skill };
}

function rows(path: string, sql: string) {
  const db = new Database(path, { create: false });
  db.run("PRAGMA query_only = ON");
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}

test("real legacy-anchor harness history is purged without resuming it or changing the direct chat", async () => {
  const directory = temporary();
  const store = new Store(directory);
  const agent = {
    ...store.createAgent(agentInput.parse({ name: "Legacy bot" }), "harness"),
    provider: "faux" as never,
    model: "test",
  };
  store.close();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new AgentRuntime(
    join(directory, "agents"),
    runtimeCallbacks({ models }),
  );
  let group = "";
  try {
    faux.setResponses([
      fauxAssistantMessage("direct sentinel"),
      fauxAssistantMessage("legacy group sentinel"),
    ]);
    const direct = await runtime.openChat(agent);
    await runtime.wait(
      await runtime.submit(agent, direct, "direct prompt", "direct"),
      agent,
    );
    group = await runtime.openAnchored(
      agent,
      defineAnchorTask("crumble.group-anchor"),
      async () => {},
    );
    await runtime.wait(
      await runtime.submit(agent, group, "legacy group prompt", "legacy"),
      agent,
    );
  } finally {
    await runtime.close();
  }
  const path = join(directory, "agents", "harness.sqlite");
  const before = rows(path, "SELECT * FROM entries WHERE conversation_id = 1");
  const counters = rows(path, "SELECT * FROM durable_metadata");
  const db = new Database(join(directory, "store.sqlite"));
  db.run(
    "DELETE FROM __drizzle_migrations WHERE name = '20261122205418_remove_group_chats'",
  );
  db.close();
  await removeLegacyGroupChats(directory);
  expect(rows(path, "SELECT * FROM entries WHERE conversation_id = 1")).toEqual(
    before,
  );
  expect(rows(path, "SELECT * FROM durable_metadata")).toEqual(counters);
  expect(
    rows(
      path,
      `SELECT id FROM conversations WHERE id = ${Number(group.split(":")[1])}`,
    ),
  ).toEqual([]);
  expect(
    JSON.stringify(rows(path, "SELECT record FROM entries")),
  ).not.toContain("legacy group sentinel");
  expect(faux.getPendingResponseCount()).toBe(0);
});

test("sibling group reviews, including orphan documents, are inventoried and replayed without touching direct reviews", async () => {
  const directory = temporary();
  const store = new Store(directory);
  const agent = {
    ...store.createAgent(agentInput.parse({ name: "Reviews" }), "reviews"),
    provider: "faux" as never,
    model: "test",
  };
  const faux = fauxProvider({ provider: "faux", models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new AgentRuntime(
    join(directory, "agents"),
    runtimeCallbacks({ models }),
  );
  let group = "";
  const removed: string[] = [];
  let retained = "";
  try {
    await runtime.openChat(agent);
    group = await runtime.openAnchored(
      agent,
      defineAnchorTask("crumble.group-anchor"),
      async () => {},
    );
    for (const execution of [
      "group-pending",
      "group-orphan",
      "direct-review",
    ]) {
      const conversation = await openReviewConversation(
        runtime,
        agent,
        {
          id: execution,
          conversationId: execution === "direct-review" ? "reviews:1" : group,
        },
        { memory: true, skills: false },
        100000,
      );
      faux.setResponses([fauxAssistantMessage(`${execution} transcript`)]);
      await runtime.wait(
        await runtime.submit(agent, conversation, "review", execution),
        agent,
      );
      if (execution === "direct-review") retained = conversation;
      else removed.push(conversation);
    }
    removed.push(
      await runtime.openAnchored(agent, ReviewAnchor, async () => {}),
    );
    const legacyReview = defineDoc<{
      executionId: string;
      groupId: string | null;
    }>({
      kind: "crumble.review-conversation",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({ executionId: "missing-execution", groupId: null }),
      checkpointWhen: () => false,
    });
    removed.push(
      await runtime.openAnchored(agent, ReviewAnchor, async (tx, id) => {
        const document = await tx.doc(legacyReview, id);
        document.groupId = "deleted-group";
      }),
    );
  } finally {
    await runtime.close();
  }
  store.createConversation({ agentId: agent.id, title: "Group" }, group);
  for (const execution of [
    "group-pending",
    "group-orphan",
    "group-pending-only",
  ])
    store.createExecution(
      {
        agentId: agent.id,
        conversationId: group,
        requestId: execution,
        prompt: "group",
        scheduleId: null,
        submissionId: null,
        status: "done",
        error: null,
      },
      execution,
    );
  for (const conversation of [...removed, retained])
    store.createConversation(
      { agentId: agent.id, title: "Review" },
      conversation,
    );
  store.addPendingReview("group-pending", agent.id, removed[0]!);
  store.addPendingReview("group-pending-only", agent.id, removed[2]!);
  store.addPendingReview("direct-review", agent.id, retained);
  store.close();
  const storePath = join(directory, "store.sqlite");
  const db = new Database(storePath);
  db.run(
    "DELETE FROM __drizzle_migrations WHERE name = '20261122205418_remove_group_chats'",
  );
  db.close();
  const path = join(directory, "agents", "reviews.sqlite");
  const counters = rows(path, "SELECT * FROM durable_metadata");
  const sentinel = rows(
    path,
    `SELECT * FROM entries WHERE conversation_id IN (1, ${Number(retained.split(":")[1])})`,
  );
  mkdirSync(join(directory, "groups"));
  mkdirSync(join(directory, "groups", "blocked.sqlite"));
  await expect(removeLegacyGroupChats(directory)).rejects.toThrow();
  const manifest = readFileSync(
    join(directory, "group-chat-removal.json"),
    "utf8",
  );
  for (const conversation of removed) {
    expect(manifest).toContain(conversation);
    expect(
      rows(
        path,
        `SELECT id FROM conversations WHERE id = ${Number(conversation.split(":")[1])}`,
      ),
    ).toEqual([]);
  }
  expect(
    rows(
      path,
      "SELECT id FROM tasks WHERE kind = json_quote('crumble.review-anchor')",
    ),
  ).toHaveLength(1);
  rmSync(join(directory, "groups", "blocked.sqlite"), { recursive: true });
  await removeLegacyGroupChats(directory);
  await removeLegacyGroupChats(directory);
  expect(rows(path, "SELECT * FROM durable_metadata")).toEqual(counters);
  expect(
    rows(
      path,
      `SELECT * FROM entries WHERE conversation_id IN (1, ${Number(retained.split(":")[1])})`,
    ),
  ).toEqual(sentinel);
  expect(
    rows(storePath, "SELECT conversation_id FROM pending_reviews"),
  ).toEqual([{ conversation_id: retained }]);
  expect(rows(storePath, "SELECT id FROM conversations")).toEqual([
    { id: retained },
  ]);
  expect(rows(storePath, "SELECT id FROM executions")).toEqual([]);
  expect(existsSync(join(directory, "group-chat-removal.json"))).toBe(false);
  const reopened = await openNodeSqliteStorage(path);
  await reopened.close(BACKGROUND_CONTEXT);
  expect(rows(path, "SELECT id FROM conversations")).toHaveLength(2);
});

test("fresh installs are bot-only and completed migrations bypass the legacy Pi schema guard", async () => {
  const directory = temporary();
  const store = new Store(directory);
  const agent = store.createAgent(
    agentInput.parse({ name: "Future bot" }),
    "future",
  );
  store.close();
  const path = await privateHistory(directory, agent.id);
  const db = new Database(path);
  db.run("UPDATE durable_schema SET version = 99");
  db.close();
  await removeLegacyGroupChats(directory);
  expect(rows(path, "SELECT id FROM conversations WHERE id = 3")).toEqual([
    { id: 3 },
  ]);
  expect(
    rows(
      join(directory, "store.sqlite"),
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'group_%'",
    ),
  ).toEqual([]);
  for (const table of ["library_files", "deleted_library_files"]) {
    const columns = rows(
      join(directory, "store.sqlite"),
      `PRAGMA table_info(${table})`,
    ) as { name: string; notnull: number }[];
    expect(columns.some((column) => column.name === "group_id")).toBe(false);
    expect(columns.find((column) => column.name === "agent_id")?.notnull).toBe(
      1,
    );
  }
  writeFileSync(
    join(directory, "group-chat-removal.json"),
    JSON.stringify({
      version: 1,
      privateHistories: [
        {
          agentId: agent.id,
          conversations: [3],
          tasks: [2],
          entries: [],
          submissions: [],
          documents: [],
        },
      ],
      conversations: [],
      executions: [],
      hashes: [],
      groupFiles: [],
    }),
  );
  await expect(removeLegacyGroupChats(directory)).rejects.toThrow(
    "Unsupported Pi",
  );
  expect(existsSync(join(directory, "group-chat-removal.json"))).toBe(true);
});

test("the forward migration preserves bot files and tombstones after a legacy purge", async () => {
  const { directory, shared } = await fixture();
  await removeLegacyGroupChats(directory);
  const path = join(directory, "store.sqlite");
  const files = rows(
    path,
    "SELECT id, agent_id, name, mime_type, size, hash, text, description, created_at FROM library_files",
  );
  const tombstones = rows(
    path,
    "SELECT id, agent_id, name FROM deleted_library_files",
  );
  await Effect.runPromise(migrateFile(path, migrationsFolder("store")));
  expect(rows(path, "SELECT * FROM library_files")).toEqual(files);
  expect(rows(path, "SELECT * FROM deleted_library_files")).toEqual(tombstones);
  expect(
    rows(
      path,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'group_%'",
    ),
  ).toEqual([]);
  expect(rows(path, "PRAGMA foreign_key_check")).toEqual([]);
  expect(
    rows(
      path,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'library_files_%'",
    ),
  ).toEqual([{ name: "library_files_bot_hash" }]);
  for (const suffix of ["", ".txt", ".pdf.txt"])
    expect(
      readFileSync(join(directory, "files", `${shared}${suffix}`), "utf8"),
    ).toBe(`${shared}${suffix} sentinel`);
  for (const name of ["member", "former", "deleted"]) {
    const db = new Database(join(directory, "agents", `${name}.sqlite`));
    db.run("UPDATE durable_schema SET version = 99");
    db.close();
  }
  await removeLegacyGroupChats(directory);
});

test("manifest replay refuses root and store-designated direct conversations before any deletion", async () => {
  for (const conversation of [1, 22]) {
    const directory = temporary();
    const path = await privateHistory(directory, "bot");
    const store = new Database(join(directory, "store.sqlite"));
    store.run(
      "CREATE TABLE conversations (id TEXT, chat INTEGER); INSERT INTO conversations VALUES ('bot:22', 1)",
    );
    store.close();
    writeFileSync(
      join(directory, "group-chat-removal.json"),
      JSON.stringify({
        version: 1,
        privateHistories: [
          {
            agentId: "bot",
            conversations: [conversation],
            tasks: [],
            entries: [],
            submissions: [],
            documents: [],
          },
        ],
        conversations: [],
        executions: [],
        hashes: [],
        groupFiles: [],
      }),
    );
    await expect(removeLegacyGroupChats(directory)).rejects.toThrow(
      conversation === 1
        ? "root/direct conversation"
        : "direct conversation bot:22",
    );
    expect(rows(path, "SELECT id FROM conversations")).toHaveLength(5);
    expect(existsSync(join(directory, "group-chat-removal.json"))).toBe(true);
  }
});

test("older partial installations skip absent group tables and owner columns", async () => {
  const directory = temporary();
  const db = new Database(join(directory, "store.sqlite"));
  db.run(
    "CREATE TABLE library_files (id TEXT, agent_id TEXT, hash TEXT); INSERT INTO library_files VALUES ('direct-file', 'bot', 'sentinel'); CREATE TABLE memories (id TEXT, content TEXT); INSERT INTO memories VALUES ('direct-memory', 'sentinel')",
  );
  db.close();
  await removeLegacyGroupChats(directory);
  expect(
    rows(join(directory, "store.sqlite"), "SELECT * FROM library_files"),
  ).toEqual([{ id: "direct-file", agent_id: "bot", hash: "sentinel" }]);
  expect(
    rows(join(directory, "store.sqlite"), "SELECT * FROM memories"),
  ).toEqual([{ id: "direct-memory", content: "sentinel" }]);
  expect(readdirSync(directory)).toEqual(["store.sqlite"]);
});

test("fresh and absent directories do not create legacy databases", async () => {
  const directory = temporary();
  await removeLegacyGroupChats(join(directory, "absent"));
  await removeLegacyGroupChats(directory);
  await removeLegacyGroupChats(directory);
  expect(readdirSync(directory)).toEqual([]);
});

test("purges archived former/deleted-group private histories without changing direct chats, reviews, calls, counters or session documents", async () => {
  const { directory, shared, exclusive } = await fixture();
  const retained = ["member", "former", "deleted"].map((agent) => {
    const path = join(directory, "agents", `${agent}.sqlite`);
    return [
      rows(path, "SELECT * FROM durable_metadata"),
      rows(path, "SELECT * FROM entries WHERE id >= 20"),
      rows(path, "SELECT * FROM document_revisions WHERE document_id >= 27"),
      rows(path, "SELECT * FROM durable_schema"),
    ];
  });
  await removeLegacyGroupChats(directory);
  for (const [index, agent] of ["member", "former", "deleted"].entries()) {
    const path = join(directory, "agents", `${agent}.sqlite`);
    expect(rows(path, "SELECT id FROM conversations ORDER BY id")).toEqual([
      { id: 1 },
      { id: 22 },
      { id: 25 },
    ]);
    expect(rows(path, "SELECT id FROM tasks ORDER BY id")).toEqual([
      { id: 21 },
      { id: 24 },
    ]);
    expect(rows(path, "SELECT id FROM submissions")).toEqual([]);
    expect(
      rows(path, "SELECT id FROM record_ids WHERE id < 20 AND id != 1"),
    ).toEqual([]);
    expect([
      rows(path, "SELECT * FROM durable_metadata"),
      rows(path, "SELECT * FROM entries WHERE id >= 20"),
      rows(path, "SELECT * FROM document_revisions WHERE document_id >= 27"),
      rows(path, "SELECT * FROM durable_schema"),
    ]).toEqual(retained[index]!);
  }
  const store = join(directory, "store.sqlite");
  for (const table of ["group_chats", "group_members", "group_turns"])
    expect(rows(store, `SELECT * FROM ${table}`)).toEqual([]);
  expect(
    rows(
      store,
      "SELECT id FROM conversations WHERE id LIKE '%:3' OR id LIKE '%:7'",
    ),
  ).toEqual([]);
  expect(rows(store, "SELECT id FROM agents ORDER BY id")).toEqual([
    { id: "deleted" },
    { id: "former" },
    { id: "member" },
  ]);
  expect(rows(store, "SELECT id FROM executions")).toHaveLength(9);
  expect(rows(store, "SELECT * FROM pending_reviews")).toHaveLength(9);
  expect(rows(store, "SELECT * FROM review_results")).toHaveLength(9);
  expect(rows(store, "SELECT id FROM library_files")).toEqual([
    { id: "bot-shared" },
  ]);
  expect(rows(store, "SELECT id FROM deleted_library_files")).toEqual([
    { id: "bot-tombstone" },
  ]);
  for (const suffix of ["", ".txt", ".pdf.txt"]) {
    expect(existsSync(join(directory, "files", `${exclusive}${suffix}`))).toBe(
      false,
    );
    expect(
      readFileSync(join(directory, "files", `${shared}${suffix}`), "utf8"),
    ).toBe(`${shared}${suffix} sentinel`);
  }
  expect(readdirSync(join(directory, "groups"))).toEqual([]);
  expect(existsSync(join(directory, "group-chat-removal.json"))).toBe(false);
  await removeLegacyGroupChats(directory);
});

test("keeps memories, skill snapshots and revert chains readable and reversible after normalizing provenance", async () => {
  const { directory } = await fixture();
  await removeLegacyGroupChats(directory);
  const store = new Store(directory);
  try {
    expect(store.getMemory("retained-memory")?.source).toBeNull();
    expect(store.getSkill("retained-skill")?.sourceExecutionId).toBeNull();
    const change = store.getChange("memory-change")!;
    expect(change.source).toEqual({});
    expect(change.actor).toBe("bot");
    expect(change.before).toMatchObject({ content: "before", source: null });
    expect(change.after).toMatchObject({ content: "after", source: null });
    expect(store.getChange("older-revert")?.revertsId).toBe("older-change");
    expect(
      store.listChanges("former").find((row) => row.target === "skill")?.after,
    ).toMatchObject({
      sourceExecutionId: null,
      instructions: "Keep these instructions",
    });
    expect(
      store.revertChange("memory-change", { actor: "owner" })?.revertsId,
    ).toBe("memory-change");
    expect(store.getMemory("retained-memory")?.content).toBe("before");
    expect(store.getMemory("retained-memory")?.source).toBeNull();
  } finally {
    store.close();
  }
});

test("removes queued group push deliveries but preserves bot notifications, devices and credentials", async () => {
  const { directory } = await fixture();
  const path = join(directory, "push.sqlite");
  const device = rows(path, "SELECT * FROM push_devices");
  const settings = rows(path, "SELECT * FROM push_settings");
  await removeLegacyGroupChats(directory);
  expect(rows(path, "SELECT id FROM push_outbox")).toEqual([{ id: "bot" }]);
  expect(rows(path, "SELECT outbox_id FROM push_delivery")).toEqual([
    { outbox_id: "bot" },
  ]);
  expect(rows(path, "SELECT * FROM push_devices")).toEqual(device);
  expect(rows(path, "SELECT * FROM push_settings")).toEqual(settings);
  expect(
    rows(path, "SELECT * FROM chat_views WHERE chat_kind = 'group'"),
  ).toEqual([]);
  expect(
    rows(path, "SELECT * FROM reply_associations WHERE chat_kind = 'group'"),
  ).toEqual([]);
  expect(
    rows(
      path,
      "SELECT event_id FROM reply_associations WHERE event_id = 'bot'",
    ),
  ).toEqual([{ event_id: "bot" }]);
});

test("reuses an inventory after private data is purged and a file deletion interrupts cleanup", async () => {
  const { directory, exclusive } = await fixture();
  const blocked = join(directory, "files", `${exclusive}.pdf.txt`);
  rmSync(blocked);
  mkdirSync(blocked);
  await expect(removeLegacyGroupChats(directory)).rejects.toThrow();
  const manifest = readFileSync(
    join(directory, "group-chat-removal.json"),
    "utf8",
  );
  expect(manifest).toContain("former-execution-3");
  expect(manifest).not.toContain("private group transcript");
  expect(
    rows(
      join(directory, "agents", "former.sqlite"),
      "SELECT id FROM tasks WHERE kind = json_quote('crumble.group-anchor')",
    ),
  ).toEqual([]);
  expect(
    rows(
      join(directory, "store.sqlite"),
      "SELECT id FROM library_files WHERE group_id IS NOT NULL",
    ),
  ).toHaveLength(2);
  rmSync(blocked, { recursive: true });
  await removeLegacyGroupChats(directory);
  expect(existsSync(join(directory, "group-chat-removal.json"))).toBe(false);
  expect(
    rows(
      join(directory, "store.sqlite"),
      "SELECT id FROM executions WHERE id LIKE '%-3'",
    ),
  ).toEqual([]);
  expect(
    rows(join(directory, "store.sqlite"), "SELECT source FROM memories"),
  ).toEqual([{ source: null }]);
});

test("rejects unsupported Pi versions and physical shapes before deleting anything", async () => {
  for (const change of [
    "UPDATE durable_schema SET version = 99",
    "ALTER TABLE tasks ADD COLUMN unknown TEXT",
  ]) {
    const directory = temporary();
    const path = await privateHistory(directory, "bot");
    const db = new Database(path);
    db.run(change);
    db.close();
    await expect(removeLegacyGroupChats(directory)).rejects.toThrow(
      "Unsupported Pi",
    );
    expect(rows(path, "SELECT id FROM conversations WHERE id = 3")).toEqual([
      { id: 3 },
    ]);
    expect(existsSync(join(directory, "group-chat-removal.json"))).toBe(false);
  }
});

test("refuses retained conversations inheriting group history without following group parents upward", async () => {
  const directory = temporary();
  const path = await privateHistory(directory, "bot");
  const db = new Database(path);
  db.run(
    "UPDATE conversations SET record = json_set(record, '$.parent', json_object('conversationId', 1, 'at', 20)) WHERE id = 3",
  );
  db.run(
    "UPDATE conversations SET record = json_set(record, '$.parent', json_object('conversationId', 3, 'at', 4)) WHERE id = 22",
  );
  db.close();
  await expect(removeLegacyGroupChats(directory)).rejects.toThrow(
    "retained Pi conversation 22 inherits",
  );
  expect(rows(path, "SELECT id FROM conversations")).toHaveLength(5);
  const repaired = new Database(path);
  repaired.run(
    "UPDATE conversations SET record = json_remove(record, '$.parent') WHERE id = 22",
  );
  repaired.close();
  await removeLegacyGroupChats(directory);
  expect(rows(path, "SELECT id FROM conversations WHERE id = 1")).toEqual([
    { id: 1 },
  ]);
});

test("refuses symlinked databases, sidecars and blob paths, and rejects traversal in a restart manifest", async () => {
  for (const parts of [
    ["agents"],
    ["groups"],
    ["store.sqlite"],
    ["store.sqlite-wal"],
  ]) {
    const directory = temporary();
    if (parts[0] === "store.sqlite-wal")
      new Database(join(directory, "store.sqlite")).close();
    symlinkSync(join(directory, "outside"), join(directory, ...parts));
    await expect(removeLegacyGroupChats(directory)).rejects.toThrow("symlink");
  }
  const { directory, exclusive } = await fixture();
  const blob = join(directory, "files", exclusive);
  rmSync(blob);
  symlinkSync(join(directory, "outside"), blob);
  await expect(removeLegacyGroupChats(directory)).rejects.toThrow("symlink");
  expect(
    rows(
      join(directory, "store.sqlite"),
      "SELECT id FROM library_files WHERE group_id IS NOT NULL",
    ),
  ).toHaveLength(2);
  writeFileSync(
    join(directory, "group-chat-removal.json"),
    JSON.stringify({
      version: 1,
      privateHistories: [],
      conversations: [],
      executions: [],
      hashes: [],
      groupFiles: ["../outside.sqlite"],
    }),
  );
  await expect(removeLegacyGroupChats(directory)).rejects.toThrow();
});
