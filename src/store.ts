import type { JsonValue } from "@earendil-works/chord";
import type { ControlState } from "./desktop-control";
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
  SkillDocument,
  SkillInput,
  ChangeBy,
  LearnedChange,
  GroupChat,
  GroupChatInput,
  GroupMember,
  GroupTurn,
  GroupTurnStatus,
  MemorySource,
} from "./domain";
import { STANDARD_TOOLS, memorySource, skillStates } from "./domain";
import { z } from "zod";
import type { AttachmentInput } from "./attachments";
import type { Credential, CredentialInfo } from "@earendil-works/pi-ai";

/** Owner messages, by entry number, whose first bot answer has not notified, with the bots they woke. */
const awaitingAnswers = z.record(z.string(), z.array(z.string()));

type Id = string;

type AttachmentRow = { attachments: string | null };

type SettingRow = { value: string };

type SettingsEntryRow = { key: string; value: string };

type CredentialRow = { value: string };

type ProviderCredentialInfoRow = { provider: string; type: Credential["type"] };

/** Typed provider credentials keep provider-specific fields such as account IDs and enterprise URLs. */
const providerCredential = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("api_key"),
      key: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .loose(),
  z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
    })
    .loose(),
]);

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
  summary: string | null;
  joined_at: string;
};

type GroupActivityRow = {
  bot_turns: number;
  paused: number;
  awaiting_answers: string;
};

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

/** Store writes without a stated actor come from the owner through the API. */
const OWNER: ChangeBy = { actor: "owner" };

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
          this.db
            .query(
              "SELECT (SELECT COUNT(*) FROM credentials) + (SELECT COUNT(*) FROM provider_credentials) AS n",
            )
            .get() as {
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
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source TEXT);
      CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, name TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT, timezone TEXT NOT NULL, run_at TEXT, enabled INTEGER NOT NULL, next_run_at TEXT, created_at TEXT NOT NULL, created_by_agent_id TEXT);
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL, submission_id TEXT, request_id TEXT NOT NULL, prompt TEXT, reply_to TEXT, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_credentials (provider TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('api_key', 'oauth')), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, enabled INTEGER NOT NULL, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS group_chats (id TEXT PRIMARY KEY, name TEXT NOT NULL, bot_turns INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, awaiting_answers TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, joined_at TEXT NOT NULL, conversation_id TEXT, cursor INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, pending_bot_started INTEGER NOT NULL DEFAULT 0, summary TEXT, PRIMARY KEY (group_id, agent_id));
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

    if (!agentCols.some((c) => c.name === "desktop_model"))
      this.db.exec("ALTER TABLE agents ADD COLUMN desktop_model TEXT");

    if (!agentCols.some((c) => c.name === "review_model"))
      this.db.exec("ALTER TABLE agents ADD COLUMN review_model TEXT");

    if (!agentCols.some((c) => c.name === "review"))
      this.db.exec("ALTER TABLE agents ADD COLUMN review TEXT");

    this.db.exec(
      "CREATE TABLE IF NOT EXISTS desktop_control (agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, holder TEXT NOT NULL, changes INTEGER NOT NULL, updated_at TEXT NOT NULL)",
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

    if (!memoryCols.some((c) => c.name === "source"))
      this.db.exec("ALTER TABLE memories ADD COLUMN source TEXT");

    // SAFETY: PRAGMA table_info returns rows with a `name` column for every table column.
    const serverCols = this.db
      .query("PRAGMA table_info(mcp_servers)")
      .all() as Array<{ name: string }>;

    if (!serverCols.some((c) => c.name === "agent_id"))
      this.db.exec(
        "ALTER TABLE mcp_servers ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE",
      );

    if (!serverCols.some((c) => c.name === "oauth_client_id"))
      this.db.exec("ALTER TABLE mcp_servers ADD COLUMN oauth_client_id TEXT");

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

    if (!groupCols.some((c) => c.name === "awaiting_answers"))
      this.db.exec(
        "ALTER TABLE group_chats ADD COLUMN awaiting_answers TEXT NOT NULL DEFAULT '{}'",
      );

    // SAFETY: PRAGMA table_info returns rows with a `name` column for every table column.
    const memberCols = this.db
      .query("PRAGMA table_info(group_members)")
      .all() as Array<{ name: string }>;

    if (!memberCols.some((c) => c.name === "conversation_id"))
      this.db.exec("ALTER TABLE group_members ADD COLUMN conversation_id TEXT");

    if (!memberCols.some((c) => c.name === "summary"))
      this.db.exec("ALTER TABLE group_members ADD COLUMN summary TEXT");

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
    this.migrateSkills();
  }
  /**
   * Skills become packages in one library: a bot's own skills move out of the agent row into it. Schema and data
   * move in one transaction, and any inline skills left behind are transferred on every startup, so a crash can
   * neither lose them nor leave them in both places.
   */
  private migrateSkills() {
    this.db.transaction(() => {
      // SAFETY: PRAGMA table_info returns rows with a `name` column for every table column.
      const skillCols = this.db
        .query("PRAGMA table_info(skills)")
        .all() as Array<{ name: string }>;

      const added: Array<[string, string]> = [
        ["agent_id", "TEXT REFERENCES agents(id) ON DELETE CASCADE"],
        ["description", "TEXT NOT NULL DEFAULT ''"],
        ["created_by", "TEXT NOT NULL DEFAULT 'owner'"],
        ["source_execution_id", "TEXT"],
        ["use_count", "INTEGER NOT NULL DEFAULT 0"],
        ["last_used_at", "TEXT"],
        ["state", "TEXT NOT NULL DEFAULT 'active'"],
        ["pinned", "INTEGER NOT NULL DEFAULT 0"],
      ];

      for (const [column, definition] of added)
        if (!skillCols.some((c) => c.name === column))
          this.db.exec(`ALTER TABLE skills ADD COLUMN ${column} ${definition}`);

      this.db.exec(
        "CREATE TABLE IF NOT EXISTS skill_documents (skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE, path TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (skill_id, path))",
      );
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS review_counters (agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, skill_rounds INTEGER NOT NULL DEFAULT 0, memory_rounds INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS pending_reviews (execution_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS review_results (execution_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, change_ids TEXT NOT NULL, created_at TEXT NOT NULL)",
      );
      // Changes outlive their targets and bots, so they carry the bot ID without a foreign key.
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS learned_changes (id TEXT PRIMARY KEY, agent_id TEXT, actor TEXT NOT NULL, target TEXT NOT NULL, target_id TEXT NOT NULL, action TEXT NOT NULL, before_state TEXT, after_state TEXT, source TEXT, reverts_id TEXT, created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS learned_changes_agent ON learned_changes(agent_id, created_at)",
      );

      const agents = this.db
        .query<{ id: string; skills: string }, []>(
          "SELECT id, skills FROM agents WHERE skills != '[]'",
        )
        .all();

      for (const agent of agents) {
        // SAFETY: the agents.skills column always held the inline skill array.
        const inline = JSON.parse(agent.skills) as Array<{
          name: string;
          instructions: string;
        }>;

        for (const skill of inline)
          this.createSkill(
            {
              agentId: agent.id,
              name: skill.name,
              description: "",
              instructions: skill.instructions,
              documents: [],
            },
            undefined,
            null,
          );
        this.db.query("UPDATE agents SET skills='[]' WHERE id=?").run(agent.id);
      }
    })();
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
    const tools: string[] = [
      ...new Set([...STANDARD_TOOLS, ...JSON.parse(r.tools)]),
    ];

    return {
      id: r.id,
      name: r.name,
      avatar: r.avatar,
      description: r.description,
      instructions: r.instructions,
      provider: r.provider,
      model: r.model,
      enabled: !!r.enabled,
      tools,
      skills: this.listSkills(r.id).map(({ name, instructions }) => ({
        name,
        instructions,
      })),
      sharedSkills: JSON.parse(r.shared_skills ?? "[]"),
      sharedMemory: tools.includes("memory"),
      mcpServers: JSON.parse(r.mcp_servers),
      delegates: this.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM agents WHERE id != ? ORDER BY created_at",
        )
        .all(r.id)
        .map((other) => other.id),
      inference: JSON.parse(r.inference ?? "{}"),
      ...(r.desktop_model && { desktopModel: JSON.parse(r.desktop_model) }),
      ...(r.review_model && { reviewModel: JSON.parse(r.review_model) }),
      ...(r.review && { review: JSON.parse(r.review) }),
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
        "INSERT INTO agents (id,name,avatar,description,instructions,provider,model,enabled,tools,skills,shared_skills,shared_memory,mcp_servers,delegates,inference,desktop_model,review_model,review,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
        "[]",
        this.j(input.sharedSkills ?? []),
        this.b(input.sharedMemory),
        this.j(input.mcpServers),
        this.j(input.delegates ?? []),
        this.j(input.inference ?? {}),
        input.desktopModel ? this.j(input.desktopModel) : null,
        input.reviewModel ? this.j(input.reviewModel) : null,
        input.review ? this.j(input.review) : null,
        t,
        t,
      );
    this.replaceAgentSkills(agentId, input.skills);

    return this.getAgent(agentId)!;
  }
  updateAgent(agentId: Id, patch: Patch<AgentInput>) {
    const old = this.getAgent(agentId);

    if (!old) return null;
    const x = { ...old, ...patch };
    const t = now();
    this.db
      .query(
        "UPDATE agents SET name=?,avatar=?,description=?,instructions=?,provider=?,model=?,enabled=?,tools=?,skills=?,shared_skills=?,shared_memory=?,mcp_servers=?,delegates=?,inference=?,desktop_model=?,review_model=?,review=?,updated_at=? WHERE id=?",
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
        "[]",
        this.j(x.sharedSkills ?? []),
        this.b(x.sharedMemory),
        this.j(x.mcpServers),
        this.j(x.delegates ?? []),
        this.j(x.inference ?? {}),
        x.desktopModel ? this.j(x.desktopModel) : null,
        x.reviewModel ? this.j(x.reviewModel) : null,
        x.review ? this.j(x.review) : null,
        t,
        agentId,
      );

    if (patch.skills) this.replaceAgentSkills(agentId, patch.skills);

    return this.getAgent(agentId);
  }
  /** The inline `skills` of an agent write: matched by name, so a kept skill keeps its documents, provenance, and usage. */
  private replaceAgentSkills(
    agentId: Id,
    skills: Array<{ name: string; instructions: string }>,
  ) {
    this.db.transaction(() => {
      const existing = this.listSkills(agentId);
      const kept = new Set<string>();

      for (const skill of skills) {
        const match = existing.find(
          (candidate) =>
            candidate.name === skill.name && !kept.has(candidate.id),
        );

        if (match) {
          kept.add(match.id);

          if (match.instructions !== skill.instructions)
            this.updateSkill(match.id, { instructions: skill.instructions });
        } else
          kept.add(
            this.createSkill({
              agentId,
              name: skill.name,
              description: "",
              instructions: skill.instructions,
              documents: [],
            }).id,
          );
      }

      for (const skill of existing)
        if (!kept.has(skill.id)) this.deleteSkill(skill.id);
    })();
  }
  /** The bot desktop's control lease; null until control first changes. */
  getDesktopControl(agentId: Id): ControlState | null {
    const row = this.db
      .query<{ holder: string; changes: number; updated_at: string }, [string]>(
        "SELECT holder, changes, updated_at FROM desktop_control WHERE agent_id=?",
      )
      .get(agentId);

    return row
      ? {
          holder: row.holder === "owner" ? "owner" : "bot",
          changes: row.changes,
          updatedAt: row.updated_at,
        }
      : null;
  }
  setDesktopControl(agentId: Id, state: ControlState) {
    this.db
      .query(
        "INSERT INTO desktop_control (agent_id, holder, changes, updated_at) VALUES (?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET holder=excluded.holder, changes=excluded.changes, updated_at=excluded.updated_at",
      )
      .run(agentId, state.holder, state.changes, state.updatedAt);
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

    const copy = this.createAgent({
      ...a,
      mcpServers,
      skills: [],
      name: name ?? `${a.name} Copy`,
    });

    // Skill packages are copied whole; archived ones stay behind, and the copy's skills were not learned from an execution.
    for (const skill of this.listSkills(a.id))
      if (skill.state !== "archived")
        this.createSkill(
          {
            ...skill,
            agentId: copy.id,
            sourceExecutionId: null,
            state: skill.state,
            pinned: skill.pinned,
          },
          undefined,
          OWNER,
        );

    return this.getAgent(copy.id)!;
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
      source: r.source
        ? (memorySource.safeParse(JSON.parse(r.source)).data ?? null)
        : null,
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
    input: {
      agentId: string | null;
      content: string;
      source?: MemorySource | null;
    },
    memoryId: string = id(),
    by: ChangeBy | null = OWNER,
  ) {
    const t = now();
    this.db
      .query(
        "INSERT INTO memories (id,agent_id,content,created_at,updated_at,source) VALUES (?,?,?,?,?,?)",
      )
      .run(
        memoryId,
        input.agentId,
        input.content,
        t,
        t,
        input.source ? JSON.stringify(input.source) : null,
      );
    const memory = this.getMemory(memoryId)!;
    this.recordChange(by, "memory", memory.agentId, memory.id, null, memory);

    return memory;
  }
  updateMemory(id: Id, patch: Patch<Memory>, by: ChangeBy | null = OWNER) {
    const m = this.getMemory(id);

    if (!m) return null;
    this.db
      .query("UPDATE memories SET content=?,updated_at=? WHERE id=?")
      .run(patch.content ?? m.content, now(), id);
    const memory = this.getMemory(id)!;
    this.recordChange(by, "memory", m.agentId, m.id, m, memory);

    return memory;
  }
  deleteMemory(id: Id, by: ChangeBy | null = OWNER) {
    const m = this.getMemory(id);

    if (!m) return false;
    this.db.query("DELETE FROM memories WHERE id=?").run(id);
    this.recordChange(by, "memory", m.agentId, m.id, m, null);

    return true;
  }
  /** Puts a memory back as it was, keeping its ID and timestamps. */
  private restoreMemory(memory: Memory) {
    this.db
      .query(
        "INSERT INTO memories (id,agent_id,content,created_at,updated_at,source) VALUES (?,?,?,?,?,?)",
      )
      .run(
        memory.id,
        memory.agentId,
        memory.content,
        memory.createdAt,
        memory.updatedAt,
        memory.source ? JSON.stringify(memory.source) : null,
      );
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
  findExecutionBySubmission(agentId: Id, submissionId: string) {
    const r = this.db
      .query("SELECT * FROM executions WHERE agent_id=? AND submission_id=?")
      .get(agentId, submissionId);

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
  private encrypt(value: string) {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key, iv);

    const data = Buffer.concat([c.update(value, "utf8"), c.final()]);

    return [iv, c.getAuthTag(), data]
      .map((x) => x.toString("base64"))
      .join(":");
  }
  private decrypt(packed: string) {
    // SAFETY: encrypt always stores exactly three base64 segments: IV, auth tag, and ciphertext.
    const [iv, tag, data] = packed
      .split(":")
      .map((x: string) => Buffer.from(x, "base64")) as [Buffer, Buffer, Buffer];

    const d = createDecipheriv("aes-256-gcm", this.key, iv);
    d.setAuthTag(tag);

    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  }
  setCredential(key: string, value: string) {
    this.db
      .query(
        "INSERT INTO credentials(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, this.encrypt(value));
  }
  getCredential(key: string) {
    // SAFETY: The query selects the encrypted credential value by its known `value` column.
    const r = this.db
      .query("SELECT value FROM credentials WHERE key=?")
      .get(key) as CredentialRow | null;

    return r ? this.decrypt(r.value) : undefined;
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

  getProviderCredential(providerId: string): Credential | undefined {
    // SAFETY: The query selects the encrypted credential value by its known `value` column.
    const r = this.db
      .query("SELECT value FROM provider_credentials WHERE provider=?")
      .get(providerId) as CredentialRow | null;

    return r
      ? providerCredential.parse(JSON.parse(this.decrypt(r.value)))
      : undefined;
  }
  setProviderCredential(providerId: string, credential: Credential) {
    const typed = providerCredential.parse(credential);

    this.db
      .query(
        "INSERT INTO provider_credentials(provider,type,value) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET type=excluded.type, value=excluded.value",
      )
      .run(providerId, typed.type, this.encrypt(JSON.stringify(typed)));
  }
  deleteProviderCredential(providerId: string) {
    return (
      this.db
        .query("DELETE FROM provider_credentials WHERE provider=?")
        .run(providerId).changes > 0
    );
  }
  /** Metadata only: listing never decrypts a credential. */
  listProviderCredentials(): CredentialInfo[] {
    // SAFETY: The query selects exactly the `provider` and constrained `type` columns.
    const rows = this.db
      .query("SELECT provider,type FROM provider_credentials ORDER BY provider")
      .all() as ProviderCredentialInfoRow[];

    return rows.map((r) => ({ providerId: r.provider, type: r.type }));
  }
  /** Moves API keys saved before typed credentials into the provider table; MCP keys never match a provider ID. */
  migrateProviderCredentials(providerIds: readonly string[]) {
    this.db.transaction(() => {
      for (const providerId of providerIds) {
        const key = this.getCredential(providerId);

        if (key === undefined) continue;

        if (!this.getProviderCredentialRow(providerId))
          this.setProviderCredential(providerId, { type: "api_key", key });
        this.deleteCredential(providerId);
      }
    })();
  }
  private getProviderCredentialRow(providerId: string) {
    return this.db
      .query("SELECT 1 FROM provider_credentials WHERE provider=?")
      .get(providerId);
  }

  private mcpServer(r: any): MCPServer {
    return {
      id: r.id,
      name: r.name,
      url: r.url,
      enabled: !!r.enabled,
      agentId: r.agent_id ?? null,
      oauthClientId: r.oauth_client_id ?? null,
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
    input: Omit<MCPServer, "id" | "agentId" | "oauthClientId"> & {
      agentId?: string | null;
      oauthClientId?: string | null;
    },
    serverId: string = id(),
  ) {
    this.db
      .query(
        "INSERT INTO mcp_servers (id,name,url,enabled,agent_id,oauth_client_id) VALUES (?,?,?,?,?,?)",
      )
      .run(
        serverId,
        input.name,
        input.url,
        this.b(input.enabled),
        input.agentId ?? null,
        input.oauthClientId ?? null,
      );

    return this.getMCPServer(serverId)!;
  }
  /** Changes a server's settings; which bot it belongs to is fixed at creation. */
  updateMCPServer(id: Id, patch: Partial<Omit<MCPServer, "id" | "agentId">>) {
    const s = this.getMCPServer(id);

    if (!s) return null;
    const x = { ...s, ...patch };
    this.db
      .query(
        "UPDATE mcp_servers SET name=?,url=?,enabled=?,oauth_client_id=? WHERE id=?",
      )
      .run(x.name, x.url, this.b(x.enabled), x.oauthClientId, id);

    return this.getMCPServer(id);
  }
  deleteMCPServer(id: Id) {
    return (
      this.db.query("DELETE FROM mcp_servers WHERE id=?").run(id).changes > 0
    );
  }

  private skill(r: any): Skill {
    const documents = this.db
      .query<{ path: string; content: string }, [string]>(
        "SELECT path, content FROM skill_documents WHERE skill_id=? ORDER BY path",
      )
      .all(r.id);

    return {
      id: r.id,
      agentId: r.agent_id ?? null,
      name: r.name,
      description: r.description ?? "",
      instructions: r.instructions,
      documents,
      createdBy: r.created_by === "bot" ? "bot" : "owner",
      sourceExecutionId: r.source_execution_id ?? null,
      useCount: r.use_count ?? 0,
      lastUsedAt: r.last_used_at ?? null,
      state: skillStates.includes(r.state) ? r.state : "active",
      pinned: !!r.pinned,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  /** One bot's skills, or the shared ones for `null`, oldest first. */
  listSkills(agentId: Id | null = null) {
    const q = agentId
      ? this.db
          .query(
            "SELECT * FROM skills WHERE agent_id=? ORDER BY created_at, rowid",
          )
          .all(agentId)
      : this.db
          .query(
            "SELECT * FROM skills WHERE agent_id IS NULL ORDER BY created_at, rowid",
          )
          .all();

    return q.map((r) => this.skill(r));
  }
  getSkill(id: Id) {
    const r = this.db.query("SELECT * FROM skills WHERE id=?").get(id);

    return r ? this.skill(r) : null;
  }
  createSkill(
    input: SkillInput & {
      agentId?: string | null;
      createdBy?: Skill["createdBy"];
      sourceExecutionId?: string | null;
      state?: Skill["state"];
      pinned?: boolean;
    },
    skillId: string = id(),
    by: ChangeBy | null = OWNER,
  ) {
    const t = now();
    this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO skills (id,agent_id,name,description,instructions,created_by,source_execution_id,state,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          skillId,
          input.agentId ?? null,
          input.name,
          input.description,
          input.instructions,
          input.createdBy ?? "owner",
          input.sourceExecutionId ?? null,
          input.state ?? "active",
          this.b(input.pinned),
          t,
          t,
        );
      this.writeSkillDocuments(skillId, input.documents);
    })();
    const skill = this.getSkill(skillId)!;
    this.recordChange(by, "skill", skill.agentId, skill.id, null, skill);

    return skill;
  }
  updateSkill(
    id: Id,
    patch: Partial<Omit<Skill, "id" | "agentId" | "createdAt" | "updatedAt">>,
    by: ChangeBy | null = OWNER,
  ) {
    const old = this.getSkill(id);

    if (!old) return null;
    const x = { ...old, ...patch };
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE skills SET name=?,description=?,instructions=?,created_by=?,source_execution_id=?,use_count=?,last_used_at=?,state=?,pinned=?,updated_at=? WHERE id=?",
        )
        .run(
          x.name,
          x.description,
          x.instructions,
          x.createdBy,
          x.sourceExecutionId,
          x.useCount,
          x.lastUsedAt,
          x.state,
          this.b(x.pinned),
          now(),
          id,
        );

      if (patch.documents) this.writeSkillDocuments(id, patch.documents);
    })();
    const skill = this.getSkill(id)!;
    this.recordChange(by, "skill", old.agentId, old.id, old, skill);

    return skill;
  }
  /** Puts a skill back as it was, keeping its ID, timestamps, and usage. */
  private restoreSkill(skill: Skill) {
    this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO skills (id,agent_id,name,description,instructions,created_by,source_execution_id,use_count,last_used_at,state,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          skill.id,
          skill.agentId,
          skill.name,
          skill.description,
          skill.instructions,
          skill.createdBy,
          skill.sourceExecutionId,
          skill.useCount,
          skill.lastUsedAt,
          skill.state,
          this.b(skill.pinned),
          skill.createdAt,
          skill.updatedAt,
        );
      this.writeSkillDocuments(skill.id, skill.documents);
    })();
  }
  private writeSkillDocuments(skillId: Id, documents: SkillDocument[]) {
    this.db.query("DELETE FROM skill_documents WHERE skill_id=?").run(skillId);

    for (const document of documents)
      this.db
        .query("INSERT INTO skill_documents VALUES (?,?,?)")
        .run(skillId, document.path, document.content);
  }
  /** Loading a skill counts as using it, and brings a stale skill back to active. */
  recordSkillUse(id: Id) {
    this.db
      .query(
        "UPDATE skills SET use_count=use_count+1, last_used_at=?, state=CASE WHEN state='stale' THEN 'active' ELSE state END WHERE id=?",
      )
      .run(now(), id);
  }
  /** Bot-created skills across every bot, for the curator. */
  listBotCreatedSkills() {
    return this.db
      .query("SELECT * FROM skills WHERE created_by='bot' ORDER BY created_at")
      .all()
      .map((r) => this.skill(r));
  }
  deleteSkill(id: Id, by: ChangeBy | null = OWNER) {
    const old = this.getSkill(id);

    if (!old) return false;
    this.db.query("DELETE FROM skills WHERE id=?").run(id);
    this.recordChange(by, "skill", old.agentId, old.id, old, null);

    return true;
  }
  /** Adds a turn's tool-activity rounds to the bot's review counters and returns the totals. */
  addReviewRounds(agentId: Id, skillRounds: number, memoryRounds: number) {
    this.db
      .query(
        "INSERT INTO review_counters (agent_id, skill_rounds, memory_rounds) VALUES (?,?,?) ON CONFLICT(agent_id) DO UPDATE SET skill_rounds=skill_rounds+excluded.skill_rounds, memory_rounds=memory_rounds+excluded.memory_rounds",
      )
      .run(agentId, skillRounds, memoryRounds);

    return this.reviewCounters(agentId);
  }
  reviewCounters(agentId: Id) {
    const row = this.db
      .query<{ skill_rounds: number; memory_rounds: number }, [string]>(
        "SELECT skill_rounds, memory_rounds FROM review_counters WHERE agent_id=?",
      )
      .get(agentId);

    return { skill: row?.skill_rounds ?? 0, memory: row?.memory_rounds ?? 0 };
  }
  /** Sets one counter: zero after a review fired, or the rounds after a turn's last write to that store. */
  setReviewCounter(agentId: Id, counter: "skill" | "memory", rounds: number) {
    const column = counter === "skill" ? "skill_rounds" : "memory_rounds";
    this.db
      .query(
        `INSERT INTO review_counters (agent_id, ${column}) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET ${column}=excluded.${column}`,
      )
      .run(agentId, rounds);
  }
  /** Reviews in flight; a server restart drops them instead of resuming. */
  listPendingReviews() {
    return this.db
      .query<
        {
          execution_id: string;
          agent_id: string;
          conversation_id: string;
          created_at: string;
        },
        []
      >("SELECT * FROM pending_reviews ORDER BY created_at")
      .all()
      .map((r) => ({
        executionId: r.execution_id,
        agentId: r.agent_id,
        conversationId: r.conversation_id,
        createdAt: r.created_at,
      }));
  }
  addPendingReview(executionId: Id, agentId: Id, conversationId: string) {
    this.db
      .query(
        "INSERT OR REPLACE INTO pending_reviews (execution_id, agent_id, conversation_id, created_at) VALUES (?,?,?,?)",
      )
      .run(executionId, agentId, conversationId, now());
  }
  removePendingReview(executionId: Id) {
    this.db
      .query("DELETE FROM pending_reviews WHERE execution_id=?")
      .run(executionId);
  }
  /** Runs `fn` atomically; a throw rolls back every write inside, including recorded changes. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private change(r: any): LearnedChange {
    return {
      id: r.id,
      agentId: r.agent_id ?? null,
      actor: r.actor,
      target: r.target,
      targetId: r.target_id,
      action: r.action,
      before: r.before_state ? JSON.parse(r.before_state) : null,
      after: r.after_state ? JSON.parse(r.after_state) : null,
      source: r.source ? JSON.parse(r.source) : null,
      revertsId: r.reverts_id ?? null,
      createdAt: r.created_at,
    };
  }
  private recordChange(
    by: ChangeBy | null,
    target: LearnedChange["target"],
    agentId: string | null,
    targetId: string,
    before: Skill | Memory | null,
    after: Skill | Memory | null,
    revertsId: string | null = null,
  ) {
    if (!by) return null;
    const changeId = id();

    // Recording is telemetry: a failure here is reported, never thrown, so it cannot undo or fail the change itself.
    try {
      return this.insertChange(
        changeId,
        by,
        target,
        agentId,
        targetId,
        before,
        after,
        revertsId,
      );
    } catch (error) {
      console.error(
        "Recording a learned change failed",
        target,
        targetId,
        error,
      );

      return null;
    }
  }
  private insertChange(
    changeId: string,
    by: ChangeBy,
    target: LearnedChange["target"],
    agentId: string | null,
    targetId: string,
    before: Skill | Memory | null,
    after: Skill | Memory | null,
    revertsId: string | null,
  ) {
    const action: LearnedChange["action"] = revertsId
      ? "revert"
      : before === null
        ? "create"
        : after === null
          ? "delete"
          : "update";

    this.db
      .query(
        "INSERT INTO learned_changes (id,agent_id,actor,target,target_id,action,before_state,after_state,source,reverts_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        changeId,
        agentId,
        by.actor,
        target,
        targetId,
        action,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        by.source ? JSON.stringify(by.source) : null,
        revertsId,
        now(),
      );

    return changeId;
  }
  /** Newest changes first: one bot's, the shared ones for `null`, or every change when `agentId` is undefined. */
  listChanges(
    agentId: string | null | undefined,
    options: { limit?: number; before?: string } = {},
  ): LearnedChange[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const cursor = options.before ? this.getChange(options.before) : null;
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (agentId === null) clauses.push("agent_id IS NULL");
    else if (agentId !== undefined) {
      clauses.push("agent_id=?");
      params.push(agentId);
    }

    if (cursor) {
      clauses.push(
        "(created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM learned_changes WHERE id=?)))",
      );
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    return this.db
      .query(
        `SELECT * FROM learned_changes ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map((r) => this.change(r));
  }
  getChange(id: Id) {
    const r = this.db.query("SELECT * FROM learned_changes WHERE id=?").get(id);

    return r ? this.change(r) : null;
  }
  /** The changes one execution's review made, oldest first. */
  listChangesOfExecution(executionId: string, actor: LearnedChange["actor"]) {
    return this.db
      .query(
        "SELECT * FROM learned_changes WHERE actor=? AND json_extract(source, '$.executionId')=? ORDER BY created_at, rowid",
      )
      .all(actor, executionId)
      .map((r) => this.change(r));
  }
  /** What a review of one execution changed, kept so clients can show it after the fact. */
  addReviewResult(executionId: Id, agentId: Id, changeIds: string[]) {
    this.db
      .query(
        "INSERT OR REPLACE INTO review_results (execution_id, agent_id, change_ids, created_at) VALUES (?,?,?,?)",
      )
      .run(executionId, agentId, JSON.stringify(changeIds), now());
  }
  listReviewResults(agentId: Id, limit = 50) {
    return this.db
      .query<
        { execution_id: string; change_ids: string; created_at: string },
        [string, number]
      >(
        "SELECT execution_id, change_ids, created_at FROM review_results WHERE agent_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(agentId, Math.min(Math.max(limit, 1), 200))
      .map((r) => ({
        executionId: r.execution_id,
        agentId,
        createdAt: r.created_at,
        // SAFETY: change_ids holds the JSON array this store wrote.
        changes: (JSON.parse(r.change_ids) as string[]).flatMap((id) => {
          const change = this.getChange(id);

          return change ? [change] : [];
        }),
      }));
  }
  /** Restores the state before `changeId`, recording the revert as a change of its own. */
  revertChange(changeId: Id, by: ChangeBy): LearnedChange | null {
    const change = this.getChange(changeId);

    if (!change) return null;

    return this.transaction(() => {
      const current =
        change.target === "skill"
          ? this.getSkill(change.targetId)
          : this.getMemory(change.targetId);

      if (change.target === "skill") {
        // SAFETY: a change's before state has the shape of its target, written by the same store.
        const before = change.before as Skill | null;

        if (current)
          this.db.query("DELETE FROM skills WHERE id=?").run(change.targetId);

        if (before) this.restoreSkill(before);
      } else {
        // SAFETY: a change's before state has the shape of its target, written by the same store.
        const before = change.before as Memory | null;

        if (current)
          this.db.query("DELETE FROM memories WHERE id=?").run(change.targetId);

        if (before) this.restoreMemory(before);
      }

      const revertId = this.recordChange(
        by,
        change.target,
        change.agentId,
        change.targetId,
        current,
        change.before,
        change.id,
      );

      return revertId ? this.getChange(revertId) : null;
    });
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
          summary: r.summary,
          joinedAt: r.joined_at,
        }
      : undefined;
  }
  setGroupMember(
    groupId: Id,
    agentId: Id,
    change: Partial<
      Pick<
        GroupMember,
        | "conversationId"
        | "cursor"
        | "pending"
        | "pendingBotStarted"
        | "summary"
      >
    >,
  ) {
    const current = this.groupMember(groupId, agentId);

    if (!current) return;
    const next = { ...current, ...change };
    this.db
      .query(
        "UPDATE group_members SET conversation_id=?,cursor=?,pending=?,pending_bot_started=?,summary=? WHERE group_id=? AND agent_id=?",
      )
      .run(
        next.conversationId,
        next.cursor,
        next.pending ? 1 : 0,
        next.pendingBotStarted ? 1 : 0,
        next.summary,
        groupId,
        agentId,
      );
  }
  groupActivity(groupId: Id) {
    const r = this.db
      .query<GroupActivityRow, [string]>(
        "SELECT bot_turns,paused,awaiting_answers FROM group_chats WHERE id=?",
      )
      .get(groupId);

    return {
      botTurns: r?.bot_turns ?? 0,
      paused: r?.paused === 1,
      /** Owner messages, by entry number, whose first bot answer has not notified yet, with the bots they woke. */
      awaitingAnswers:
        awaitingAnswers.safeParse(JSON.parse(r?.awaiting_answers ?? "{}"))
          .data ?? {},
    };
  }
  setGroupActivity(
    groupId: Id,
    change: Partial<{
      botTurns: number;
      paused: boolean;
      awaitingAnswers: Record<string, string[]>;
    }>,
  ) {
    const next = { ...this.groupActivity(groupId), ...change };
    this.db
      .query(
        "UPDATE group_chats SET bot_turns=?,paused=?,awaiting_answers=? WHERE id=?",
      )
      .run(
        next.botTurns,
        next.paused ? 1 : 0,
        JSON.stringify(next.awaitingAnswers),
        groupId,
      );
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
