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
  folder: "Personal",
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
    const schedule = store.createSchedule({
      agentId: agent.id,
      name: "Routine",
      prompt: "go",
      cron: "0 * * * *",
      timezone: "UTC",
      runAt: null,
      enabled: true,
    });
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
    expect((execution as any).replyTo).toBe("assistant@example.com");
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
      "CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, avatar TEXT, description TEXT, instructions TEXT, provider TEXT, model TEXT, enabled INTEGER, folder TEXT, tools TEXT, skills TEXT, mcp_servers TEXT, created_at TEXT, updated_at TEXT)",
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
    expect((store.getAgent("legacy") as any)?.inference).toEqual({});
    store.close();
  });

  test("persists inference settings through updates and duplication", () => {
    const store = new Store(make());
    const agent = store.createAgent({
      ...input,
      inference: {
        thinkingLevel: "max",
        temperature: 0.2,
        maxOutputTokens: 400,
      },
    } as any);
    expect((agent as any).inference).toEqual({
      thinkingLevel: "max",
      temperature: 0.2,
      maxOutputTokens: 400,
    });
    const updated = store.updateAgent(agent.id, {
      inference: { thinkingLevel: "minimal" },
    } as any)!;
    expect((updated as any).inference).toEqual({ thinkingLevel: "minimal" });
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
    expect((conversation as any).archived).toBe(false);
    expect(store.archiveConversation(conversation.id)?.archived).toBe(true);
    expect(store.listConversations(agent.id)).toHaveLength(0);
    expect(store.listConversations(agent.id, true)).toHaveLength(1);
    store.close();
    const reopened = new Store(dir);
    expect((reopened.getConversation(conversation.id) as any)?.archived).toBe(
      true,
    );
    expect(reopened.restoreConversation(conversation.id)?.archived).toBe(false);
    expect(reopened.listConversations(agent.id)).toHaveLength(1);
    reopened.close();
  });
});
