import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Store } from "../../test/support/store";
import { ConversationRepository } from "../bot-store/conversation-repository";
import { SettingsRepository } from "./settings-repository";

const dirs: string[] = [];

const make = () => {
  const d = mkdtempSync(join(tmpdir(), "bot-store-"));
  dirs.push(d);

  return d;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const input = {
  name: "Test",
  description: "",
  instructions: "hello",
  provider: "openai" as const,
  model: "gpt-4.1",
  enabled: true,
  tools: ["memory"],
  skills: [],
  mcpServers: [],
  delegates: [],
};

describe("Store", () => {
  test("upgrades skill provenance without changing existing skills", () => {
    const dir = make();
    const first = new Store(dir);
    const agent = first.createAgent(input);

    const skill = first.createSkill({
      agentId: agent.id,
      name: "Existing",
      description: "Before copies",
      instructions: "Keep this",
      documents: [{ path: "references/a.md", content: "Keep this too" }],
    });

    first.close();
    const db = new Database(join(dir, "store.sqlite"));

    // Recreate the schema before copy provenance, the two avatar migrations, and the dropped agent columns.
    db.run(
      `DROP TABLE relayed_job_questions;
      DROP TABLE delegation_receipts;
      DROP TABLE bot_message_requests;
      ALTER TABLE conversations DROP COLUMN chat;
      ALTER TABLE agents ADD COLUMN skills text NOT NULL DEFAULT '[]';
      ALTER TABLE agents ADD COLUMN delegates text NOT NULL DEFAULT '[]';
      ALTER TABLE agents ADD COLUMN shared_memory integer NOT NULL DEFAULT 0;
      ALTER TABLE skills DROP COLUMN copied_from_skill_id;
      DELETE FROM __drizzle_migrations WHERE id IN (SELECT id FROM __drizzle_migrations ORDER BY id DESC LIMIT 4)`,
    );
    db.close();
    const reopened = new Store(dir);

    expect(reopened.getSkill(skill.id)).toEqual({
      ...skill,
      copiedFromSkillId: null,
    });
    reopened.close();
  });

  test("persists agents and cascades dependent records after reopen", () => {
    const dir = make();
    const first = new Store(dir);
    const agent = first.createAgent(input);

    const convo = first.createConversation({
      agentId: agent.id,
      title: "Chat",
    });

    first.createMemory({ agentId: agent.id, content: "fact" });
    first.close();
    const reopened = new Store(dir);
    expect(reopened.getAgent(agent.id)?.name).toBe("Test");
    expect(reopened.listConversations(agent.id).map(({ id }) => id)).toEqual([
      convo.id,
    ]);
    expect(reopened.deleteAgent(agent.id)).toBe(true);
    expect(reopened.getConversation(convo.id)).toBeNull();
    reopened.close();
  });

  test("encrypts credentials and round trips settings", () => {
    const dir = make();
    const store = new Store(dir);
    store.setCredential("openai", "super-secret");
    expect(store.getCredential("openai")).toBe("super-secret");
    store.setSetting("flags", { enabled: true });
    expect(store.getSetting("flags")).toEqual({ enabled: true });
    store.close();
    const reopened = new Store(dir);
    expect(reopened.getCredential("openai")).toBe("super-secret");
    expect(reopened.getSetting("flags")).toEqual({ enabled: true });
    reopened.close();
    expect(
      readdirSync(dir, { recursive: true, withFileTypes: true }).filter(
        (entry) =>
          entry.isFile() &&
          readFileSync(join(entry.parentPath, entry.name)).includes(
            "super-secret",
          ),
      ),
    ).toEqual([]);
  });

  test("supports schedules, idempotent executions, and MCP lifecycle", () => {
    const store = new Store(make());
    const agent = store.createAgent(input);

    const conversation = store.createConversation({
      agentId: agent.id,
      title: "Run",
    });

    const schedule = store.createSchedule(
      {
        agentId: agent.id,
        name: "Routine",
        kind: "prompt",
        command: null,
        timeoutSeconds: 600,
        notify: true,
        prompt: "go",
        cron: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        eventSourceId: null,
        enabled: true,
      },
      undefined,
      agent.id,
    );

    expect(schedule.createdByAgentId).toBe(agent.id);
    expect(
      store.updateNextRunAt(schedule.id, "2026-01-01T00:00:00.000Z")?.nextRunAt,
    ).toBe("2026-01-01T00:00:00.000Z");

    const execution = store.createExecution({
      agentId: agent.id,
      conversationId: conversation.id,
      scheduleId: schedule.id,
      submissionId: null,
      requestId: "req-1",
      prompt: "go",
      status: "pending",
      error: null,
      replyTo: "assistant@example.com",
    });

    // SAFETY: The execution row includes the optional replyTo field.
    expect((execution as any).replyTo).toBe("assistant@example.com");
    // SAFETY: The update payload intentionally exercises the nullable field.
    expect(
      (store.updateExecution(execution.id, { replyTo: null } as any) as any)
        .replyTo,
    ).toBeNull();
    expect(store.getExecutionByRequest(conversation.id, "req-1")?.id).toBe(
      execution.id,
    );
    expect(() =>
      store.createExecution({
        agentId: agent.id,
        conversationId: conversation.id,
        scheduleId: schedule.id,
        submissionId: null,
        requestId: "req-1",
        prompt: "go",
        status: "pending",
        error: null,
      }),
    ).toThrow('Failed query: insert into "executions"');

    const server = store.createMCPServer({
      name: "Tools",
      url: "https://example.test/mcp",
      enabled: true,
    });

    expect(store.updateMCPServer(server.id, { enabled: false })?.enabled).toBe(
      false,
    );
    expect(store.deleteMCPServer(server.id)).toBe(true);
    store.close();
  });

  test("moves each bot's chat from the settings to its conversation", () => {
    const dir = make();
    const first = new Store(dir);
    const agent = first.createAgent(input);
    const chat = first.createConversation({ agentId: agent.id, title: "Chat" });
    const other = first.createConversation({ agentId: agent.id, title: "Job" });
    first.close();

    const db = new Database(join(dir, "store.sqlite"));

    db.run(`DROP TABLE relayed_job_questions;
      DROP TABLE delegation_receipts;
      DROP TABLE bot_message_requests;
      ALTER TABLE conversations DROP COLUMN chat;
      ALTER TABLE agents ADD COLUMN skills text NOT NULL DEFAULT '[]';
      ALTER TABLE agents ADD COLUMN delegates text NOT NULL DEFAULT '[]';
      ALTER TABLE agents ADD COLUMN shared_memory integer NOT NULL DEFAULT 0;
      DELETE FROM __drizzle_migrations WHERE id = (SELECT MAX(id) FROM __drizzle_migrations)`);
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      `chat:${agent.id}`,
      JSON.stringify(chat.id),
    );
    db.close();

    const reopened = new Store(dir);

    expect(
      reopened.run(
        ConversationRepository.use((conversations) =>
          conversations.chatOf(agent.id),
        ),
      )?.id,
    ).toBe(chat.id);
    expect(other.id).not.toBe(chat.id);
    expect(
      reopened.run(
        SettingsRepository.use((settings) => settings.get(`chat:${agent.id}`)),
      ),
    ).toBeUndefined();
    reopened.close();
  });

  test("keeps a skill's package when the bot's inline skills are written", () => {
    const store = new Store(make());

    store.createAgent(
      {
        ...input,
        skills: [{ name: "Research", instructions: "Check sources" }],
      },
      "legacy",
    );
    store.createSkill({
      agentId: null,
      name: "Shared",
      description: "",
      instructions: "Shared rules",
      documents: [],
    });
    const [research] = store.listSkills("legacy");
    expect(research).toMatchObject({
      agentId: "legacy",
      name: "Research",
      description: "",
      documents: [],
      createdBy: "owner",
      useCount: 0,
      state: "active",
      pinned: false,
    });
    expect(store.listSkills(null).map((skill) => skill.name)).toEqual([
      "Shared",
    ]);

    store.updateSkill(research!.id, {
      description: "Find sources",
      documents: [{ path: "references/sources.md", content: "Primary first" }],
      createdBy: "bot",
    });
    store.recordSkillUse(research!.id);
    store.updateAgent("legacy", {
      skills: [
        { name: "Research", instructions: "Check primary sources" },
        { name: "Writing", instructions: "Short sentences" },
      ],
    });
    const after = store.listSkills("legacy");
    expect(after.map((skill) => skill.name)).toEqual(["Research", "Writing"]);
    expect(after[0]).toMatchObject({
      id: research!.id,
      instructions: "Check primary sources",
      description: "Find sources",
      documents: [{ path: "references/sources.md", content: "Primary first" }],
      createdBy: "bot",
      useCount: 1,
    });
    expect(after[0]!.lastUsedAt).not.toBeNull();
    store.updateAgent("legacy", { skills: [] });
    expect(store.listSkills("legacy")).toEqual([]);
    expect(store.getSkill(research!.id)).toBeNull();
    const copy = store.duplicateAgent("legacy");
    expect(copy?.skills).toEqual([]);
    store.close();
  });

  test("records skill and memory changes and reverts them one at a time", () => {
    const store = new Store(make());
    const agent = store.createAgent(input);

    const skill = store.createSkill(
      {
        agentId: agent.id,
        name: "Research",
        description: "",
        instructions: "Check sources",
        documents: [],
        createdBy: "bot",
        sourceExecutionId: "exec-1",
      },
      undefined,
      { actor: "bot", source: { executionId: "exec-1" } },
    );

    store.updateSkill(
      skill.id,
      { instructions: "Check primary sources" },
      { actor: "review", source: { executionId: "exec-2" } },
    );
    store.deleteSkill(skill.id);

    const memory = store.createMemory(
      { agentId: agent.id, content: "fact", source: { kind: "chat" } },
      undefined,
      { actor: "bot" },
    );

    const changes = store.listChanges(agent.id);
    expect(
      changes.map((change) => [change.actor, change.target, change.action]),
    ).toEqual([
      ["bot", "memory", "create"],
      ["owner", "skill", "delete"],
      ["review", "skill", "update"],
      ["bot", "skill", "create"],
    ]);
    expect(changes[2]!.source).toEqual({ executionId: "exec-2" });
    expect(store.listChanges(agent.id, { limit: 2 })).toHaveLength(2);
    expect(
      store.listChanges(agent.id, { limit: 2, before: changes[1]!.id }),
    ).toEqual(changes.slice(2));
    expect(store.listChanges(null)).toEqual([]);

    // Undo the delete: the skill is back as it was before deletion, with its ID.
    const undelete = store.revertChange(changes[1]!.id, { actor: "owner" });
    expect(undelete).toMatchObject({
      action: "revert",
      revertsId: changes[1]!.id,
      actor: "owner",
    });
    expect(store.getSkill(skill.id)).toMatchObject({
      instructions: "Check primary sources",
      createdBy: "bot",
      sourceExecutionId: "exec-1",
    });

    // Undo the update: back to the first instructions.
    store.revertChange(changes[2]!.id, { actor: "owner" });
    expect(store.getSkill(skill.id)?.instructions).toBe("Check sources");

    // Undo the create: the skill is gone.
    store.revertChange(changes[3]!.id, { actor: "owner" });
    expect(store.getSkill(skill.id)).toBeNull();

    store.revertChange(changes[0]!.id, { actor: "owner" });
    expect(store.getMemory(memory.id)).toBeNull();

    expect(store.revertChange("missing", { actor: "owner" })).toBeNull();
    expect(store.listChanges(agent.id)[0]).toMatchObject({
      action: "revert",
      target: "memory",
    });

    // Duplicating a bot copies its skill packages whole, except archived ones.
    const kept = store.createSkill({
      agentId: agent.id,
      name: "Kept",
      description: "Keep me",
      instructions: "Whole package",
      documents: [{ path: "references/depth.md", content: "Depth" }],
      createdBy: "bot",
      sourceExecutionId: "exec-3",
      state: "stale",
      pinned: true,
    });

    store.createSkill({
      agentId: agent.id,
      name: "Gone",
      description: "",
      instructions: "Archived",
      documents: [],
      state: "archived",
    });

    const copy = store.duplicateAgent(agent.id)!;
    expect(copy.skills).toEqual([
      { name: "Kept", instructions: "Whole package" },
    ]);
    expect(store.listSkills(copy.id)[0]).toMatchObject({
      description: "Keep me",
      documents: [{ path: "references/depth.md", content: "Depth" }],
      createdBy: "bot",
      sourceExecutionId: null,
      state: "stale",
      pinned: true,
    });
    expect(store.listSkills(copy.id)[0]!.id).not.toBe(kept.id);
    store.close();
  });

  test("persists inference settings through updates and duplication", () => {
    const store = new Store(make());

    // SAFETY: This fixture supplies the inference extension accepted by the store schema.
    const agent = store.createAgent({
      ...input,
      inference: {
        thinkingLevel: "max",
        temperature: 0.2,
        maxOutputTokens: 400,
      },
    } as any);

    // SAFETY: The created agent includes the persisted inference field.
    expect((agent as any).inference).toEqual({
      thinkingLevel: "max",
      temperature: 0.2,
      maxOutputTokens: 400,
    });

    // SAFETY: This fixture supplies the inference extension accepted by the store schema.
    const updated = store.updateAgent(agent.id, {
      inference: { thinkingLevel: "minimal" },
    } as any)!;

    // SAFETY: The updated agent includes the persisted inference field.
    expect((updated as any).inference).toEqual({ thinkingLevel: "minimal" });
    // SAFETY: Duplicated agents preserve the persisted inference field.
    expect((store.duplicateAgent(agent.id) as any).inference).toEqual({
      thinkingLevel: "minimal",
    });
    store.close();
  });

  test("archives conversations by default and restores them", () => {
    const dir = make();
    const store = new Store(dir);
    const agent = store.createAgent(input);

    const conversation = store.createConversation({
      agentId: agent.id,
      title: "Archive me",
    });

    // SAFETY: Conversations expose the optional archived field.
    expect((conversation as any).archived).toBe(false);
    expect(store.archiveConversation(conversation.id)?.archived).toBe(true);
    expect(store.listConversations(agent.id)).toHaveLength(0);
    expect(store.listConversations(agent.id, true)).toHaveLength(1);
    store.close();
    const reopened = new Store(dir);
    // SAFETY: Reopened conversations expose the optional archived field.
    expect((reopened.getConversation(conversation.id) as any)?.archived).toBe(
      true,
    );
    expect(reopened.restoreConversation(conversation.id)?.archived).toBe(false);
    expect(reopened.listConversations(agent.id)).toHaveLength(1);
    reopened.close();
  });
});

describe("Store memory sources", () => {
  test("keeps a memory's source and reports older memories without one", () => {
    const dir = make();
    const first = new Store(dir);
    const agent = first.createAgent(input);
    const older = first.createMemory({ agentId: agent.id, content: "older" });

    const sourced = first.createMemory({
      agentId: agent.id,
      content: "Leaves Friday",
      source: { kind: "group", groupId: "group-1", name: "Trip" },
    });

    first.close();

    const reopened = new Store(dir);
    expect(reopened.getMemory(older.id)?.source).toBeNull();
    expect(reopened.getMemory(sourced.id)?.source).toEqual({
      kind: "group",
      groupId: "group-1",
      name: "Trip",
    });
    reopened.close();
  });
});

describe("Store group chats", () => {
  test("keeps members in join order, replaces them, and survives reopen", () => {
    const dir = make();
    const first = new Store(dir);
    const a = first.createAgent({ ...input, name: "A" });
    const b = first.createAgent({ ...input, name: "B" });
    const c = first.createAgent({ ...input, name: "C" });

    const group = first.createGroupChat({
      name: "Trip",
      memberIds: [b.id, a.id],
    });

    expect(group).toMatchObject({ name: "Trip", memberIds: [b.id, a.id] });

    const updated = first.updateGroupChat(group.id, {
      name: "Holiday",
      memberIds: [a.id, c.id],
    });

    expect(updated).toMatchObject({
      id: group.id,
      name: "Holiday",
      memberIds: [a.id, c.id],
    });
    expect(first.updateGroupChat(crypto.randomUUID(), group)).toBeNull();
    first.close();

    const second = new Store(dir);
    expect(second.listGroupChats()).toEqual([updated!]);
    second.close();
  });

  test("drops a deleted bot from its groups and deletes members with the group", () => {
    const dir = make();
    const store = new Store(dir);
    const a = store.createAgent({ ...input, name: "A" });
    const b = store.createAgent({ ...input, name: "B" });
    const c = store.createAgent({ ...input, name: "C" });

    const group = store.createGroupChat({
      name: "Trip",
      memberIds: [a.id, b.id, c.id],
    });

    store.deleteAgent(b.id);
    expect(store.getGroupChat(group.id)?.memberIds).toEqual([a.id, c.id]);
    expect(store.deleteGroupChat(group.id)).toBe(true);
    expect(store.getGroupChat(group.id)).toBeNull();
    expect(store.listGroupChats()).toEqual([]);
    store.close();

    const db = new Database(join(dir, "store.sqlite"));

    expect(db.query("SELECT COUNT(*) AS n FROM group_members").get()).toEqual({
      n: 0,
    });
    db.close();
  });

  test("keeps member progress, group activity, and turns across reopen", () => {
    const dir = make();
    const first = new Store(dir);
    const a = first.createAgent({ ...input, name: "A" });
    const b = first.createAgent({ ...input, name: "B" });

    const group = first.createGroupChat({
      name: "Trip",
      memberIds: [a.id, b.id],
    });

    const conversation = first.createConversation(
      { agentId: a.id, title: "Trip" },
      `${a.id}:2`,
    );

    const execution = first.createExecution({
      agentId: a.id,
      conversationId: conversation.id,
      scheduleId: null,
      requestId: "group-turn:1",
      prompt: "",
      submissionId: null,
      status: "pending",
      error: null,
    });

    first.setGroupMember(group.id, a.id, {
      conversationId: conversation.id,
      cursor: 3,
      pending: true,
      pendingBotStarted: true,
      summary: "Earlier: packing list.",
    });
    first.setGroupActivity(group.id, {
      botTurns: 5,
      paused: true,
      awaitingAnswers: { "2": [a.id] },
    });
    first.createGroupTurn({
      executionId: execution.id,
      groupId: group.id,
      agentId: a.id,
      through: 3,
      botStarted: true,
      status: "running",
    });
    first.close();

    const second = new Store(dir);
    expect(second.groupMember(group.id, a.id)).toMatchObject({
      conversationId: conversation.id,
      cursor: 3,
      pending: true,
      pendingBotStarted: true,
      summary: "Earlier: packing list.",
    });
    expect(second.groupActivity(group.id)).toEqual({
      botTurns: 5,
      paused: true,
      awaitingAnswers: { "2": [a.id] },
    });
    expect(second.activeGroupTurn(group.id, a.id)).toMatchObject({
      executionId: execution.id,
      through: 3,
      botStarted: true,
      status: "running",
    });
    second.updateGroupTurn(execution.id, { status: "settled" });
    expect(second.activeGroupTurn(group.id, a.id)).toBeUndefined();
    expect(
      second.listGroupTurns({ groupId: group.id, status: ["settled"] }),
    ).toHaveLength(1);
    second.deleteGroupChat(group.id);
    expect(second.listGroupTurns()).toEqual([]);
    second.close();
  });
});

test("an agent keeps its desktop job model across reopen", () => {
  const dir = make();
  const first = new Store(dir);

  const agent = first.createAgent({
    ...input,
    desktopModel: { provider: "opencode-go", model: "gpt-6-luna" },
  });

  first.close();

  const second = new Store(dir);

  expect(second.getAgent(agent.id)?.desktopModel).toEqual({
    provider: "opencode-go",
    model: "gpt-6-luna",
  });
  expect(
    second.updateAgent(agent.id, { desktopModel: undefined })?.desktopModel,
  ).toBeUndefined();
  second.close();
});
