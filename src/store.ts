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
} from "./domain";
import type { AttachmentInput } from "./attachments";

type Id = string;
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
        (this.db.query("SELECT COUNT(*) AS n FROM credentials").get() as any).n,
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
      .exec(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, enabled INTEGER NOT NULL, folder TEXT NOT NULL, tools TEXT NOT NULL, skills TEXT NOT NULL, mcp_servers TEXT NOT NULL, delegates TEXT NOT NULL DEFAULT '[]', inference TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, name TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT, timezone TEXT NOT NULL, run_at TEXT, enabled INTEGER NOT NULL, next_run_at TEXT, created_at TEXT NOT NULL, created_by_agent_id TEXT);
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL, submission_id TEXT, request_id TEXT NOT NULL, prompt TEXT, reply_to TEXT, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, enabled INTEGER NOT NULL, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE);`);
    const agentCols = this.db.query("PRAGMA table_info(agents)").all() as any[];
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
    // Shared memories have no bot, and SQLite cannot drop NOT NULL in place.
    const memoryCols = this.db
      .query("PRAGMA table_info(memories)")
      .all() as any[];
    if (memoryCols.find((c) => c.name === "agent_id")?.notnull)
      this.db.transaction(() => {
        this.db
          .exec(`CREATE TABLE memories_next (id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          INSERT INTO memories_next SELECT id, agent_id, content, created_at, updated_at FROM memories;
          DROP TABLE memories;
          ALTER TABLE memories_next RENAME TO memories;`);
      })();
    const serverCols = this.db
      .query("PRAGMA table_info(mcp_servers)")
      .all() as any[];
    if (!serverCols.some((c) => c.name === "agent_id"))
      this.db.exec(
        "ALTER TABLE mcp_servers ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE",
      );
    const conversationCols = this.db
      .query("PRAGMA table_info(conversations)")
      .all() as any[];
    if (!conversationCols.some((c) => c.name === "archived"))
      this.db.exec(
        "ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
      );
    const scheduleCols = this.db
      .query("PRAGMA table_info(schedules)")
      .all() as any[];
    if (!scheduleCols.some((c) => c.name === "created_by_agent_id"))
      this.db.exec("ALTER TABLE schedules ADD COLUMN created_by_agent_id TEXT");
    const cols = this.db.query("PRAGMA table_info(executions)").all() as any[];
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
  private j(v: unknown) {
    return JSON.stringify(v);
  }
  private b(v: unknown) {
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
      folder: r.folder,
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
        "INSERT INTO agents (id,name,avatar,description,instructions,provider,model,enabled,folder,tools,skills,shared_skills,shared_memory,mcp_servers,delegates,inference,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
        input.folder,
        this.j(input.tools),
        this.j(input.skills),
        this.j(input.sharedSkills ?? []),
        this.b(input.sharedMemory),
        this.j(input.mcpServers),
        this.j(input.delegates ?? []),
        this.j((input as AgentInput & { inference?: unknown }).inference ?? {}),
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
        "UPDATE agents SET name=?,avatar=?,description=?,instructions=?,provider=?,model=?,enabled=?,folder=?,tools=?,skills=?,shared_skills=?,shared_memory=?,mcp_servers=?,delegates=?,inference=?,updated_at=? WHERE id=?",
      )
      .run(
        x.name,
        x.avatar,
        x.description,
        x.instructions,
        x.provider,
        x.model,
        this.b(x.enabled),
        x.folder,
        this.j(x.tools),
        this.j(x.skills),
        this.j(x.sharedSkills ?? []),
        this.b(x.sharedMemory),
        this.j(x.mcpServers),
        this.j(x.delegates ?? []),
        this.j((x as Agent & { inference?: unknown }).inference ?? {}),
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
        this.b((patch as any).archived ?? (c as any).archived),
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
    const r = this.db
      .query("SELECT attachments FROM executions WHERE id=?")
      .get(id) as { attachments: string | null } | null;
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
        (x as typeof x & { replyTo?: string | null }).replyTo ?? null,
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
    const r = this.db
      .query("SELECT value FROM settings WHERE key=?")
      .get(key) as any;
    return r ? JSON.parse(r.value) : undefined;
  }
  setSetting(key: string, value: unknown) {
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
    const out: Record<string, unknown> = {};
    for (const r of this.db
      .query("SELECT key,value FROM settings")
      .all() as any[])
      out[r.key] = JSON.parse(r.value);
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
    const r = this.db
      .query("SELECT value FROM credentials WHERE key=?")
      .get(key) as any;
    if (!r) return undefined;
    const [iv, tag, data] = r.value
      .split(":")
      .map((x: string) => Buffer.from(x, "base64"));
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
    return (
      this.db.query("SELECT key FROM credentials ORDER BY key").all() as any[]
    ).map((r) => r.key);
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
    return (
      this.db.query("SELECT * FROM mcp_servers ORDER BY name").all() as any[]
    ).map((r) => this.mcpServer(r));
  }
  getMCPServer(id: Id) {
    const r = this.db
      .query("SELECT * FROM mcp_servers WHERE id=?")
      .get(id) as any;
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
}
