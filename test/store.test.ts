import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Store } from "../src/store";

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
  avatar: "sparkles",
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
    expect(reopened.listConversations(agent.id)).toHaveLength(1);
    expect(reopened.deleteAgent(agent.id)).toBe(true);
    expect(reopened.getConversation(convo.id)).toBeNull();
    reopened.close();
  });

  test("encrypts credentials and round trips settings", () => {
    const dir = make();
    const store = new Store(dir);
    store.setCredential("openai", "super-secret");
    expect(store.getCredential("openai")).toBe("super-secret");
    expect(store.listCredentials()).toEqual(["openai"]);
    store.setSetting("flags", { enabled: true });
    expect(store.getSetting("flags")).toEqual({ enabled: true });
    store.close();
    const reopened = new Store(dir);
    expect(reopened.getCredential("openai")).toBe("super-secret");
    expect(reopened.getSetting("flags")).toEqual({ enabled: true });
    reopened.close();
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
        prompt: "go",
        cron: "0 * * * *",
        timezone: "UTC",
        runAt: null,
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
    ).toThrow();

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

  test("migrates an older agent schema without losing rows", () => {
    const dir = make();
    const db = new Database(join(dir, "store.sqlite"));
    db.exec(
      "CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, avatar TEXT, description TEXT, instructions TEXT, provider TEXT, model TEXT, enabled INTEGER, folder TEXT NOT NULL, tools TEXT, skills TEXT, mcp_servers TEXT, created_at TEXT, updated_at TEXT)",
    );
    db.query("INSERT INTO agents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "legacy",
      "Legacy",
      "sparkles",
      "",
      "old",
      "openai",
      "gpt-4.1",
      1,
      "Personal",
      "[]",
      "[]",
      "[]",
      "2020-01-01",
      "2020-01-01",
    );
    db.close();
    const store = new Store(dir);
    expect(store.getAgent("legacy")?.name).toBe("Legacy");
    expect(store.getAgent("legacy")?.delegates).toEqual([]);
    // SAFETY: Migration adds the optional inference field to legacy agents.
    expect((store.getAgent("legacy") as any)?.inference).toEqual({});
    expect(store.getAgent("legacy")).not.toHaveProperty("folder");
    expect(store.createAgent(input).name).toBe(input.name);
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

    const db = new Database(join(dir, "store.sqlite"));
    db.exec("ALTER TABLE memories DROP COLUMN source");
    db.close();

    const upgraded = new Store(dir);
    expect(upgraded.getMemory(sourced.id)?.source).toBeNull();

    const again = upgraded.createMemory({
      agentId: agent.id,
      content: "Leaves Friday",
      source: { kind: "task", scheduleId: "schedule-1", name: "Morning" },
    });

    upgraded.close();

    const reopened = new Store(dir);
    expect(reopened.getMemory(older.id)?.source).toBeNull();
    expect(reopened.getMemory(again.id)?.source).toEqual({
      kind: "task",
      scheduleId: "schedule-1",
      name: "Morning",
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

  test("upgrades a milestone 1 database and keeps its groups", () => {
    const dir = make();
    const first = new Store(dir);
    const a = first.createAgent({ ...input, name: "A" });
    const b = first.createAgent({ ...input, name: "B" });

    const group = first.createGroupChat({
      name: "Trip",
      memberIds: [a.id, b.id],
    });

    first.close();

    const db = new Database(join(dir, "store.sqlite"));
    db.exec(`DROP TABLE group_turns;
      ALTER TABLE group_chats DROP COLUMN bot_turns;
      ALTER TABLE group_chats DROP COLUMN paused;
      ALTER TABLE group_chats DROP COLUMN awaiting_answer;
      ALTER TABLE group_members DROP COLUMN conversation_id;
      ALTER TABLE group_members DROP COLUMN cursor;
      ALTER TABLE group_members DROP COLUMN pending;
      ALTER TABLE group_members DROP COLUMN pending_bot_started;
      ALTER TABLE group_members DROP COLUMN summary;`);
    db.close();

    const second = new Store(dir);
    expect(second.getGroupChat(group.id)?.memberIds).toEqual([a.id, b.id]);
    expect(second.groupMember(group.id, a.id)).toEqual({
      groupId: group.id,
      agentId: a.id,
      conversationId: null,
      cursor: 0,
      pending: false,
      pendingBotStarted: false,
      summary: null,
    });
    expect(second.groupActivity(group.id)).toEqual({
      botTurns: 0,
      paused: false,
      awaitingAnswer: 0,
    });
    second.close();
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
      awaitingAnswer: 2,
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
      awaitingAnswer: 2,
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
