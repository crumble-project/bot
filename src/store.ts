import type { JsonValue } from "@earendil-works/chord";
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type {
  Agent,
  AgentInput,
  Conversation,
  Memory,
  Schedule,
  ScheduleInput,
  Execution,
  MCPServer,
  Skill,
  GroupChat,
  GroupChatInput,
  GroupMember,
  GroupTurn,
  GroupTurnStatus,
} from "./domain";
import type { AttachmentInput } from "./attachments";

type Id = string;

type AttachmentRow = { attachments: string | null };

type SettingRow = { value: string };

type SettingsEntryRow = { key: string; value: string };

type CredentialRow = { value: string };

type KeyRow = { key: string };

type GroupChatRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type GroupMemberRow = { agent_id: string };

type GroupMemberStateRow = {
  group_id: string;
  agent_id: string;
  conversation_id: string | null;
  cursor: number;
  pending: number;
  pending_bot_started: number;
};

type GroupActivityRow = { bot_turns: number; paused: number };

type GroupTurnRow = {
  execution_id: string;
  group_id: string;
  agent_id: string;
  through: number;
  bot_started: number;
  status: GroupTurnStatus;
  created_at: string;
};

type Patch<T> = Partial<Omit<T, "id" | "createdAt" | "updatedAt">>;

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

export class Store {
  private db: Database;
  private key: Buffer;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const keyPath = join(dataDir, ".secret.key");
    const keyExists = existsSync(keyPath);
    this.key = keyExists ? readFileSync(keyPath) : randomBytes(32);
    this.db = new Database(join(dataDir, "store.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();

    if (
      !keyExists &&
      Number(
        // SAFETY: SQLite returns the selected COUNT(*) row with the declared `n` column.
        (
          this.db.query("SELECT COUNT(*) AS n FROM credentials").get() as {
            n: number;
          }
        ).n,
      ) > 0
    ) {
      this.db.close();
      throw new Error(
        "Credential encryption key is missing; refusing to overwrite it",
      );
    }

    if (!keyExists) writeFileSync(keyPath, this.key, { mode: 0o600 });

    try {
      chmodSync(keyPath, 0o600);
    } catch {
      /* permissions are best effort on Windows */
    }
  }
  private migrate() {
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, enabled INTEGER NOT NULL, tools TEXT NOT NULL, skills TEXT NOT NULL, mcp_servers TEXT NOT NULL, delegates TEXT NOT NULL DEFAULT '[]', inference TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, name TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT, timezone TEXT NOT NULL, run_at TEXT, enabled INTEGER NOT NULL, next_run_at TEXT, created_at TEXT NOT NULL, created_by_agent_id TEXT);
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL, submission_id TEXT, request_id TEXT NOT NULL, prompt TEXT, reply_to TEXT, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, enabled INTEGER NOT NULL, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS group_chats (id TEXT PRIMARY KEY, name TEXT NOT NULL, bot_turns INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, joined_at TEXT NOT NULL, conversation_id TEXT, cursor INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, pending_bot_started INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (group_id, agent_id));
      CREATE TABLE IF NOT EXISTS group_turns (execution_id TEXT PRIMARY KEY REFERENCES executions(id) ON DELETE CASCADE, group_id TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, through INTEGER NOT NULL, bot_started INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);`);

    // SAFETY: PRAGMA table_info returns rows with a `name` column for every table column.
    const agentCols = this.db
      .query("PRAGMA table_info(agents)")
      .all() as Array<{ name: string }>;

    if (!agentCols.some((c) => c.name === "delegates"))
      this.db.exec(
        "ALTER TABLE agents ADD COLUMN delegates TEXT NOT NULL DEFAULT '[]'",
      );

    if (!agentCols.some((c) => c.name === "inference"))
      this.db.exec(
        "ALTER TABLE agents ADD COLUMN inference TEXT NOT NULL DEFAULT '{}'",
      );

    if (!agentCols.some((c) => c.name === "shared_skills"))
      this.db.exec(
        "ALTER TABLE agents ADD COLUMN shared_skills TEXT NOT NULL DEFAULT '[]'",
      );

    if (!agentCols.some((c) => c.name === "shared_memory"))
      this.db.exec(
        "ALTER TABLE agents ADD COLUMN shared_memory INTEGER NOT NULL DEFAULT 0",
      );

    if (agentCols.some((c) => c.name === "folder"))
      this.db.exec("ALTER TABLE agents DROP COLUMN folder");

    // Shared memories have no bot, and SQLite cannot drop NOT NULL in place.
    // SAFETY: PRAGMA table_info returns rows with a `name` and numeric `notnull` column.
    const memoryCols = this.db
      .query("PRAGMA table_info(memories)")
      .all() as Array<{ name: string; notnull: number }>;

    if (memoryCols.find((c) => c.name === "agent_id")?.notnull)
      this.db.transaction(() => {
        this.db
          .exec(`CREATE TABLE memories_next (id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          INSERT INTO memories_next SELECT id, agent_id, content, created_at, updated_at FROM memories;
          DROP TABLE memories;
          ALTER TABLE memories_next RENAME TO memories;`);
      })();

    // SAFETY: PRAGMA table_info returns rows with a `name` column for every table column.
    const serverCols = this.db
      .query("PRAGMA table_info(mcp_servers)")
      .all() as Array<{ name: string }>;

    if (!serverCols.some((c) => c.name === "agent_id"))
      this.db.exec(
        "ALTER TABLE mcp_servers ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE",
      );

    // SAFETY: PRAGMA table_info returns rows with a `name` column for every table column.
    const conversationCols = this.db
      .query("PRAGMA table_info(conversations)")
      .all() as Array<{ name: string }>;

    if (!conversationCols.some((c) => c.name === "archived"))
      this.db.exec(
        "ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
      );

    // SAFETY: PRAGMA table_info returns rows with a `name` column for every table column.
    const scheduleCols = this.db
      .query("PRAGMA table_info(schedules)")
      .all() as Array<{ name: string }>;

    if (!scheduleCols.some((c) => c.name === "created_by_agent_id"))
      this.db.exec("ALTER TABLE schedules ADD COLUMN created_by_agent_id TEXT");

    // SAFETY: PRAGMA table_info returns rows with a `name` column for every table column.
    const groupCols = this.db
      .query("PRAGMA table_info(group_chats)")
      .all() as Array<{ name: string }>;

    if (!groupCols.some((c) => c.name === "bot_turns"))
      this.db.exec(
        "ALTER TABLE group_chats ADD COLUMN bot_turns INTEGER NOT NULL DEFAULT 0",
      );

    if (!groupCols.some((c) => c.name === "paused"))
      this.db.exec(
        "ALTER TABLE group_chats ADD COLUMN paused INTEGER NOT NULL DEFAULT 0",
      );

    // SAFETY: PRAGMA table_info returns rows with a `name` column for every table column.
    const memberCols = this.db
      .query("PRAGMA table_info(group_members)")
      .all() as Array<{ name: string }>;

    if (!memberCols.some((c) => c.name === "conversation_id"))
      this.db.exec("ALTER TABLE group_members ADD COLUMN conversation_id TEXT");

    for (const column of ["cursor", "pending", "pending_bot_started"])
      if (!memberCols.some((c) => c.name === column))
        this.db.exec(
          `ALTER TABLE group_members ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
        );

    // SAFETY: PRAGMA table_info returns rows with a `name` column for every table column.
    const cols = this.db.query("PRAGMA table_info(executions)").all() as Array<{
      name: string;
    }>;

    if (!cols.some((c) => c.name === "prompt"))
      this.db.exec("ALTER TABLE executions ADD COLUMN prompt TEXT");

    if (!cols.some((c) => c.name === "reply_to"))
      this.db.exec("ALTER TABLE executions ADD COLUMN reply_to TEXT");

    if (!cols.some((c) => c.name === "attachments"))
      this.db.exec("ALTER TABLE executions ADD COLUMN attachments TEXT");

    if (!cols.some((c) => c.name === "attachments_digest"))
      this.db.exec("ALTER TABLE executions ADD COLUMN attachments_digest TEXT");
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS executions_conversation_request ON executions(conversation_id, request_id)",
    );
  }
  close() {
    this.db.close();
  }
  private j<T>(v: T) {
    return JSON.stringify(v);
  }
  private b(v: boolean | null | undefined) {
    return v ? 1 : 0;
  }
  private agent(r: any): Agent {
    return {
      id: r.id,
      name: r.name,
      avatar: r.avatar,
      description: r.description,
      instructions: r.instructions,
      provider: r.provider,
      model: r.model,
      enabled: !!r.enabled,
      tools: JSON.parse(r.tools),
      skills: JSON.parse(r.skills),
      sharedSkills: JSON.parse(r.shared_skills ?? "[]"),
      sharedMemory: !!r.shared_memory,
      mcpServers: JSON.parse(r.mcp_servers),
      delegates: JSON.parse(r.delegates ?? "[]"),
      inference: JSON.parse(r.inference ?? "{}"),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  listAgents() {
    return this.db
      .query("SELECT * FROM agents ORDER BY created_at")
      .all()
      .map((r) => this.agent(r));
  }
  getAgent(agentId: Id) {
    const r = this.db.query("SELECT * FROM agents WHERE id=?").get(agentId);

    return r ? this.agent(r) : null;
  }
  createAgent(input: AgentInput, agentId: string = id()): Agent {
    const t = now();
    this.db
      .query(
        "INSERT INTO agents (id,name,avatar,description,instructions,provider,model,enabled,tools,skills,shared_skills,shared_memory,mcp_servers,delegates,inference,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        agentId,
        input.name,
        input.avatar,
        input.description,
        input.instructions,
        input.provider,
        input.model,
        this.b(input.enabled),
        this.j(input.tools),
        this.j(input.skills),
        this.j(input.sharedSkills ?? []),
        this.b(input.sharedMemory),
        this.j(input.mcpServers),
        this.j(input.delegates ?? []),
        this.j(input.inference ?? {}),
        t,
        t,
      );

    return this.getAgent(agentId)!;
  }
  updateAgent(agentId: Id, patch: Patch<AgentInput>) {
    const old = this.getAgent(agentId);

    if (!old) return null;
    const x = { ...old, ...patch };
    const t = now();
    this.db
      .query(
        "UPDATE agents SET name=?,avatar=?,description=?,instructions=?,provider=?,model=?,enabled=?,tools=?,skills=?,shared_skills=?,shared_memory=?,mcp_servers=?,delegates=?,inference=?,updated_at=? WHERE id=?",
      )
      .run(
        x.name,
        x.avatar,
        x.description,
        x.instructions,
        x.provider,
        x.model,
        this.b(x.enabled),
        this.j(x.tools),
        this.j(x.skills),
        this.j(x.sharedSkills ?? []),
        this.b(x.sharedMemory),
        this.j(x.mcpServers),
        this.j(x.delegates ?? []),
        this.j(x.inference ?? {}),
        t,
        agentId,
      );

    return this.getAgent(agentId);
  }
  deleteAgent(agentId: Id) {
    return (
      this.db.query("DELETE FROM agents WHERE id=?").run(agentId).changes > 0
    );
  }
  duplicateAgent(agentId: Id, name?: string) {
    const a = this.getAgent(agentId);

    if (!a) return null;

    // Personal servers keep belonging to the original bot.
    const mcpServers = a.mcpServers.filter(
      (serverId) => !this.getMCPServer(serverId)?.agentId,
    );

    return this.createAgent({
      ...a,
      mcpServers,
      name: name ?? `${a.name} Copy`,
    });
  }

  private convo(r: any): Conversation {
    return {
      id: r.id,
      agentId: r.agent_id,
      title: r.title,
      archived: !!r.archived,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  listConversations(agentId?: Id, includeArchived = false) {
    const filter = includeArchived ? "" : " AND archived=0";

    const q = agentId
      ? this.db
          .query(
            `SELECT * FROM conversations WHERE agent_id=?${filter} ORDER BY updated_at DESC`,
          )
          .all(agentId)
      : this.db
          .query(
            `SELECT * FROM conversations${filter ? " WHERE archived=0" : ""} ORDER BY updated_at DESC`,
          )
          .all();

    return q.map((r) => this.convo(r));
  }
  getConversation(id: Id) {
    const r = this.db.query("SELECT * FROM conversations WHERE id=?").get(id);

    return r ? this.convo(r) : null;
  }
  createConversation(
    input: { agentId: string; title: string },
    conversationId: string = id(),
  ) {
    const t = now();
    this.db
      .query(
        "INSERT INTO conversations (id,agent_id,title,archived,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(conversationId, input.agentId, input.title, 0, t, t);

    return this.getConversation(conversationId)!;
  }
  updateConversation(id: Id, patch: Patch<Conversation>) {
    const c = this.getConversation(id);

    if (!c) return null;
    this.db
      .query(
        "UPDATE conversations SET title=?,archived=?,updated_at=? WHERE id=?",
      )
      .run(
        patch.title ?? c.title,
        this.b(patch.archived ?? c.archived),
        now(),
        id,
      );

    return this.getConversation(id);
  }
  archiveConversation(id: Id) {
    return this.setConversationArchived(id, true);
  }
  restoreConversation(id: Id) {
    return this.setConversationArchived(id, false);
  }
  private setConversationArchived(id: Id, archived: boolean) {
    if (!this.getConversation(id)) return null;
    this.db
      .query("UPDATE conversations SET archived=?,updated_at=? WHERE id=?")
      .run(this.b(archived), now(), id);

    return this.getConversation(id);
  }
  deleteConversation(id: Id) {
    return (
      this.db.query("DELETE FROM conversations WHERE id=?").run(id).changes > 0
    );
  }

  private memory(r: any): Memory {
    return {
      id: r.id,
      agentId: r.agent_id,
      content: r.content,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  /** One bot's memories, or the shared ones for `null`. */
  listMemories(agentId: Id | null) {
    const q = agentId
      ? this.db
          .query("SELECT * FROM memories WHERE agent_id=? ORDER BY created_at")
          .all(agentId)
      : this.db
          .query(
            "SELECT * FROM memories WHERE agent_id IS NULL ORDER BY created_at",
          )
          .all();

    return q.map((r) => this.memory(r));
  }
  getMemory(id: Id) {
    const r = this.db.query("SELECT * FROM memories WHERE id=?").get(id);

    return r ? this.memory(r) : null;
  }
  createMemory(
    input: { agentId: string | null; content: string },
    memoryId: string = id(),
  ) {
    const t = now();
    this.db
      .query("INSERT INTO memories VALUES (?,?,?,?,?)")
      .run(memoryId, input.agentId, input.content, t, t);

    return this.getMemory(memoryId)!;
  }
  updateMemory(id: Id, patch: Patch<Memory>) {
    const m = this.getMemory(id);

    if (!m) return null;
    this.db
      .query("UPDATE memories SET content=?,updated_at=? WHERE id=?")
      .run(patch.content ?? m.content, now(), id);

    return this.getMemory(id);
  }
  deleteMemory(id: Id) {
    return this.db.query("DELETE FROM memories WHERE id=?").run(id).changes > 0;
  }

  private schedule(r: any): Schedule {
    return {
      id: r.id,
      agentId: r.agent_id,
      name: r.name,
      prompt: r.prompt,
      cron: r.cron,
      timezone: r.timezone,
      runAt: r.run_at,
      enabled: !!r.enabled,
      nextRunAt: r.next_run_at,
      createdAt: r.created_at,
      createdByAgentId: r.created_by_agent_id ?? null,
    };
  }
  listSchedules(agentId?: Id) {
    const q = agentId
      ? this.db
          .query("SELECT * FROM schedules WHERE agent_id=? ORDER BY created_at")
          .all(agentId)
      : this.db.query("SELECT * FROM schedules ORDER BY created_at").all();

    return q.map((r) => this.schedule(r));
  }
  getSchedule(id: Id) {
    const r = this.db.query("SELECT * FROM schedules WHERE id=?").get(id);

    return r ? this.schedule(r) : null;
  }
  createSchedule(
    input: ScheduleInput,
    scheduleId: string = id(),
    createdByAgentId: string | null = null,
  ) {
    const t = now(),
      next = input.runAt;

    this.db
      .query(
        "INSERT INTO schedules (id,agent_id,name,prompt,cron,timezone,run_at,enabled,next_run_at,created_at,created_by_agent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        scheduleId,
        input.agentId,
        input.name,
        input.prompt,
        input.cron,
        input.timezone,
        input.runAt,
        this.b(input.enabled),
        next,
        t,
        createdByAgentId,
      );

    return this.getSchedule(scheduleId)!;
  }
  updateSchedule(id: Id, patch: Partial<ScheduleInput>) {
    const s = this.getSchedule(id);

    if (!s) return null;
    const x = { ...s, ...patch };
    this.db
      .query(
        "UPDATE schedules SET agent_id=?,name=?,prompt=?,cron=?,timezone=?,run_at=?,enabled=?,next_run_at=? WHERE id=?",
      )
      .run(
        x.agentId,
        x.name,
        x.prompt,
        x.cron,
        x.timezone,
        x.runAt,
        this.b(x.enabled),
        x.runAt,
        id,
      );

    return this.getSchedule(id);
  }
  deleteSchedule(id: Id) {
    return (
      this.db.query("DELETE FROM schedules WHERE id=?").run(id).changes > 0
    );
  }
  updateNextRunAt(id: Id, nextRunAt: string | null) {
    if (!this.getSchedule(id)) return null;
    this.db
      .query("UPDATE schedules SET next_run_at=? WHERE id=?")
      .run(nextRunAt, id);

    return this.getSchedule(id);
  }

  listExecutions(agentId?: Id) {
    const q = agentId
      ? this.db
          .query(
            "SELECT * FROM executions WHERE agent_id=? ORDER BY created_at DESC",
          )
          .all(agentId)
      : this.db
          .query("SELECT * FROM executions ORDER BY created_at DESC")
          .all();

    return q.map(this.execution);
  }
  private execution(r: any) {
    return {
      id: r.id,
      agentId: r.agent_id,
      conversationId: r.conversation_id,
      scheduleId: r.schedule_id,
      submissionId: r.submission_id,
      requestId: r.request_id,
      status: r.status,
      error: r.error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      prompt: r.prompt ?? "",
      replyTo: r.reply_to ?? null,
      attachmentsDigest: r.attachments_digest ?? null,
    };
  }
  /** Uploads waiting for admission; cleared once Pi holds them, so they are not stored twice. */
  executionAttachments(id: Id): AttachmentInput[] {
    // SAFETY: The query selects the nullable `attachments` column by name.
    const r = this.db
      .query("SELECT attachments FROM executions WHERE id=?")
      .get(id) as AttachmentRow | null;

    return r?.attachments ? JSON.parse(r.attachments) : [];
  }
  clearExecutionAttachments(id: Id) {
    this.db.query("UPDATE executions SET attachments=NULL WHERE id=?").run(id);
  }
  getExecution(id: Id) {
    const r = this.db.query("SELECT * FROM executions WHERE id=?").get(id);

    return r ? this.execution(r) : null;
  }
  getExecutionByRequest(conversationId: Id, requestId: string) {
    const r = this.db
      .query(
        "SELECT * FROM executions WHERE conversation_id=? AND request_id=?",
      )
      .get(conversationId, requestId);

    return r ? this.execution(r) : null;
  }
  findExecution(conversationId: Id, requestId: string) {
    return this.getExecutionByRequest(conversationId, requestId);
  }
  createExecution(
    input: Omit<Execution, "id" | "createdAt" | "updatedAt"> & {
      prompt?: string;
      replyTo?: string | null;
      attachments?: AttachmentInput[];
    },
    executionId: string = id(),
  ) {
    const t = now();
    this.db
      .query(
        "INSERT INTO executions (id,agent_id,conversation_id,schedule_id,submission_id,request_id,prompt,reply_to,attachments,attachments_digest,status,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        executionId,
        input.agentId,
        input.conversationId,
        input.scheduleId,
        input.submissionId,
        input.requestId,
        input.prompt ?? null,
        input.replyTo ?? null,
        input.attachments?.length ? JSON.stringify(input.attachments) : null,
        input.attachmentsDigest ?? null,
        input.status,
        input.error,
        t,
        t,
      );

    return this.getExecution(executionId)!;
  }
  updateExecution(id: Id, patch: Partial<Execution>) {
    const e = this.getExecution(id);

    if (!e) return null;
    const x = { ...e, ...patch };
    this.db
      .query(
        "UPDATE executions SET status=?,error=?,submission_id=?,request_id=?,reply_to=?,updated_at=? WHERE id=?",
      )
      .run(
        x.status,
        x.error,
        x.submissionId,
        x.requestId,
        x.replyTo ?? null,
        now(),
        id,
      );

    return this.getExecution(id);
  }
  deleteExecution(id: Id) {
    return (
      this.db.query("DELETE FROM executions WHERE id=?").run(id).changes > 0
    );
  }

  getSetting<T = unknown>(key: string): T | undefined {
    // SAFETY: The query selects the JSON setting value by its known `value` column.
    const r = this.db
      .query("SELECT value FROM settings WHERE key=?")
      .get(key) as SettingRow | null;

    return r ? JSON.parse(r.value) : undefined;
  }
  setSetting<T>(key: string, value: T) {
    this.db
      .query(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, this.j(value));

    return value;
  }
  deleteSetting(key: string) {
    return (
      this.db.query("DELETE FROM settings WHERE key=?").run(key).changes > 0
    );
  }
  listSettings() {
    const out: Record<string, JsonValue> = {};

    // SAFETY: The query selects exactly the `key` and JSON `value` columns.
    const rows = this.db
      .query("SELECT key,value FROM settings")
      .all() as SettingsEntryRow[];

    for (const r of rows) out[r.key] = JSON.parse(r.value);

    return out;
  }
  setCredential(key: string, value: string) {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key, iv);

    const data = Buffer.concat([c.update(value, "utf8"), c.final()]);

    const packed = [iv, c.getAuthTag(), data]
      .map((x) => x.toString("base64"))
      .join(":");

    this.db
      .query(
        "INSERT INTO credentials(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, packed);
  }
  getCredential(key: string) {
    // SAFETY: The query selects the encrypted credential value by its known `value` column.
    const r = this.db
      .query("SELECT value FROM credentials WHERE key=?")
      .get(key) as CredentialRow | null;

    if (!r) return undefined;

    // SAFETY: setCredential always stores exactly three base64 segments: IV, auth tag, and ciphertext.
    const [iv, tag, data] = r.value
      .split(":")
      .map((x: string) => Buffer.from(x, "base64")) as [Buffer, Buffer, Buffer];

    const d = createDecipheriv("aes-256-gcm", this.key, iv);
    d.setAuthTag(tag);

    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  }
  deleteCredential(key: string) {
    return (
      this.db.query("DELETE FROM credentials WHERE key=?").run(key).changes > 0
    );
  }
  listCredentials() {
    // SAFETY: The query selects exactly the credential `key` column.
    const rows = this.db
      .query("SELECT key FROM credentials ORDER BY key")
      .all() as KeyRow[];

    return rows.map((r) => r.key);
  }

  private mcpServer(r: any): MCPServer {
    return {
      id: r.id,
      name: r.name,
      url: r.url,
      enabled: !!r.enabled,
      agentId: r.agent_id ?? null,
    };
  }
  listMCPServers() {
    return this.db
      .query("SELECT * FROM mcp_servers ORDER BY name")
      .all()
      .map((r) => this.mcpServer(r));
  }
  getMCPServer(id: Id) {
    const r = this.db.query("SELECT * FROM mcp_servers WHERE id=?").get(id);

    return r ? this.mcpServer(r) : null;
  }
  /** A server the bot may use: enabled, and shared or its own. */
  usableMCPServer(agentId: Id, serverId: Id) {
    const server = this.getMCPServer(serverId);

    return server?.enabled && (!server.agentId || server.agentId === agentId)
      ? server
      : null;
  }
  createMCPServer(
    input: Omit<MCPServer, "id" | "agentId"> & { agentId?: string | null },
    serverId: string = id(),
  ) {
    this.db
      .query(
        "INSERT INTO mcp_servers (id,name,url,enabled,agent_id) VALUES (?,?,?,?,?)",
      )
      .run(
        serverId,
        input.name,
        input.url,
        this.b(input.enabled),
        input.agentId ?? null,
      );

    return this.getMCPServer(serverId)!;
  }
  /** Changes a server's settings; which bot it belongs to is fixed at creation. */
  updateMCPServer(id: Id, patch: Partial<Omit<MCPServer, "id" | "agentId">>) {
    const s = this.getMCPServer(id);

    if (!s) return null;
    const x = { ...s, ...patch };
    this.db
      .query("UPDATE mcp_servers SET name=?,url=?,enabled=? WHERE id=?")
      .run(x.name, x.url, this.b(x.enabled), id);

    return this.getMCPServer(id);
  }
  deleteMCPServer(id: Id) {
    return (
      this.db.query("DELETE FROM mcp_servers WHERE id=?").run(id).changes > 0
    );
  }

  private skill(r: any): Skill {
    return {
      id: r.id,
      name: r.name,
      instructions: r.instructions,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  listSkills() {
    return this.db
      .query("SELECT * FROM skills ORDER BY name")
      .all()
      .map((r) => this.skill(r));
  }
  getSkill(id: Id) {
    const r = this.db.query("SELECT * FROM skills WHERE id=?").get(id);

    return r ? this.skill(r) : null;
  }
  createSkill(
    input: { name: string; instructions: string },
    skillId: string = id(),
  ) {
    const t = now();
    this.db
      .query("INSERT INTO skills VALUES (?,?,?,?,?)")
      .run(skillId, input.name, input.instructions, t, t);

    return this.getSkill(skillId)!;
  }
  updateSkill(id: Id, patch: Patch<Skill>) {
    const old = this.getSkill(id);

    if (!old) return null;
    const x = { ...old, ...patch };
    this.db
      .query("UPDATE skills SET name=?,instructions=?,updated_at=? WHERE id=?")
      .run(x.name, x.instructions, now(), id);

    return this.getSkill(id);
  }
  deleteSkill(id: Id) {
    return this.db.query("DELETE FROM skills WHERE id=?").run(id).changes > 0;
  }

  private groupChat(r: GroupChatRow): GroupChat {
    const members = this.db
      .query<GroupMemberRow, [string]>(
        "SELECT agent_id FROM group_members WHERE group_id=? ORDER BY joined_at, rowid",
      )
      .all(r.id);

    return {
      id: r.id,
      name: r.name,
      memberIds: members.map((member) => member.agent_id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  listGroupChats() {
    return this.db
      .query<GroupChatRow, []>(
        "SELECT * FROM group_chats ORDER BY created_at, rowid",
      )
      .all()
      .map((r) => this.groupChat(r));
  }
  getGroupChat(groupId: Id) {
    const r = this.db
      .query<GroupChatRow, [string]>("SELECT * FROM group_chats WHERE id=?")
      .get(groupId);

    return r ? this.groupChat(r) : null;
  }
  createGroupChat(input: GroupChatInput, groupId: string = id()) {
    const t = now();

    this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO group_chats (id,name,created_at,updated_at) VALUES (?,?,?,?)",
        )
        .run(groupId, input.name, t, t);
      this.insertGroupMembers(groupId, input.memberIds, t);
    })();

    return this.getGroupChat(groupId)!;
  }
  /** Replaces name and members; members that stay keep their place in the join order. */
  updateGroupChat(groupId: Id, input: GroupChatInput) {
    const current = this.getGroupChat(groupId);

    if (!current) return null;
    const t = now();
    const kept = new Set(input.memberIds);

    this.db.transaction(() => {
      this.db
        .query("UPDATE group_chats SET name=?,updated_at=? WHERE id=?")
        .run(input.name, t, groupId);

      for (const agentId of current.memberIds)
        if (!kept.has(agentId))
          this.db
            .query("DELETE FROM group_members WHERE group_id=? AND agent_id=?")
            .run(groupId, agentId);

      this.insertGroupMembers(
        groupId,
        input.memberIds.filter(
          (agentId) => !current.memberIds.includes(agentId),
        ),
        t,
      );
    })();

    return this.getGroupChat(groupId);
  }
  private insertGroupMembers(groupId: Id, agentIds: Id[], joinedAt: string) {
    const insert = this.db.query(
      "INSERT INTO group_members (group_id,agent_id,joined_at) VALUES (?,?,?)",
    );

    for (const agentId of agentIds) insert.run(groupId, agentId, joinedAt);
  }
  deleteGroupChat(groupId: Id) {
    return (
      this.db.query("DELETE FROM group_chats WHERE id=?").run(groupId).changes >
      0
    );
  }

  groupMember(groupId: Id, agentId: Id): GroupMember | undefined {
    const r = this.db
      .query<GroupMemberStateRow, [string, string]>(
        "SELECT * FROM group_members WHERE group_id=? AND agent_id=?",
      )
      .get(groupId, agentId);

    return r
      ? {
          groupId: r.group_id,
          agentId: r.agent_id,
          conversationId: r.conversation_id,
          cursor: r.cursor,
          pending: r.pending === 1,
          pendingBotStarted: r.pending_bot_started === 1,
        }
      : undefined;
  }
  setGroupMember(
    groupId: Id,
    agentId: Id,
    change: Partial<
      Pick<
        GroupMember,
        "conversationId" | "cursor" | "pending" | "pendingBotStarted"
      >
    >,
  ) {
    const current = this.groupMember(groupId, agentId);

    if (!current) return;
    const next = { ...current, ...change };
    this.db
      .query(
        "UPDATE group_members SET conversation_id=?,cursor=?,pending=?,pending_bot_started=? WHERE group_id=? AND agent_id=?",
      )
      .run(
        next.conversationId,
        next.cursor,
        next.pending ? 1 : 0,
        next.pendingBotStarted ? 1 : 0,
        groupId,
        agentId,
      );
  }
  groupActivity(groupId: Id) {
    const r = this.db
      .query<GroupActivityRow, [string]>(
        "SELECT bot_turns,paused FROM group_chats WHERE id=?",
      )
      .get(groupId);

    return { botTurns: r?.bot_turns ?? 0, paused: r?.paused === 1 };
  }
  setGroupActivity(
    groupId: Id,
    change: Partial<{ botTurns: number; paused: boolean }>,
  ) {
    const next = { ...this.groupActivity(groupId), ...change };
    this.db
      .query("UPDATE group_chats SET bot_turns=?,paused=? WHERE id=?")
      .run(next.botTurns, next.paused ? 1 : 0, groupId);
  }
  private groupTurn(r: GroupTurnRow): GroupTurn {
    return {
      executionId: r.execution_id,
      groupId: r.group_id,
      agentId: r.agent_id,
      through: r.through,
      botStarted: r.bot_started === 1,
      status: r.status,
      createdAt: r.created_at,
    };
  }
  createGroupTurn(turn: Omit<GroupTurn, "createdAt">) {
    this.db
      .query(
        "INSERT INTO group_turns (execution_id,group_id,agent_id,through,bot_started,status,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        turn.executionId,
        turn.groupId,
        turn.agentId,
        turn.through,
        turn.botStarted ? 1 : 0,
        turn.status,
        now(),
      );

    return this.getGroupTurn(turn.executionId)!;
  }
  getGroupTurn(executionId: Id) {
    const r = this.db
      .query<GroupTurnRow, [string]>(
        "SELECT * FROM group_turns WHERE execution_id=?",
      )
      .get(executionId);

    return r ? this.groupTurn(r) : undefined;
  }
  updateGroupTurn(executionId: Id, change: { status: GroupTurnStatus }) {
    this.db
      .query("UPDATE group_turns SET status=? WHERE execution_id=?")
      .run(change.status, executionId);
  }
  /** The member's unsettled turn in the group; there is at most one. */
  activeGroupTurn(groupId: Id, agentId: Id) {
    const r = this.db
      .query<GroupTurnRow, [string, string]>(
        "SELECT * FROM group_turns WHERE group_id=? AND agent_id=? AND status!='settled' ORDER BY created_at DESC, rowid DESC",
      )
      .get(groupId, agentId);

    return r ? this.groupTurn(r) : undefined;
  }
  listGroupTurns(filter: { groupId?: Id; status?: GroupTurnStatus[] } = {}) {
    return this.db
      .query<GroupTurnRow, []>(
        "SELECT * FROM group_turns ORDER BY created_at, rowid",
      )
      .all()
      .map((r) => this.groupTurn(r))
      .filter(
        (turn) =>
          (!filter.groupId || turn.groupId === filter.groupId) &&
          (!filter.status || filter.status.includes(turn.status)),
      );
  }
}
