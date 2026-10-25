import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Agent } from "../shared/domain";
import { assertOwnMemoryInGroup, memorySourceOf } from "./memory-sources";
import { AgentRuntime, type MemoryContext } from "../bots/runtime";
import { Store } from "../shared/store";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-memory-sources-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
};

const input = (name: string) => ({
  name,
  avatar: "bot",
  description: "",
  instructions: "",
  provider: "faux",
  model: "chat",
  enabled: true,
  tools: ["memory"],
  skills: [],
  mcpServers: [],
  delegates: [],
});

describe("memorySourceOf", () => {
  function setup() {
    const store = new Store(temp());
    cleanups.push(() => store.close());
    const agent = store.createAgent(input("Ada"));
    const other = store.createAgent(input("Grace"));

    const conversation = store.createConversation({
      agentId: agent.id,
      title: "Ada",
    });

    const execution = (requestId: string, scheduleId: string | null = null) =>
      store.createExecution({
        agentId: agent.id,
        conversationId: conversation.id,
        scheduleId,
        submissionId: requestId,
        requestId,
        prompt: "",
        status: "running",
        error: null,
      });

    return { store, agent, other, execution };
  }

  test("names the group of a group turn", () => {
    const { store, agent, other } = setup();

    const group = store.createGroupChat({
      name: "Trip",
      memberIds: [agent.id, other.id],
    });

    expect(
      memorySourceOf(store, agent.id, {
        groupId: group.id,
        submissionIds: [],
        reviewOf: null,
      }),
    ).toEqual({ kind: "group", groupId: group.id, name: "Trip" });
  });

  test("takes the newest input of a chat run", () => {
    const { store, agent, other, execution } = setup();

    const schedule = store.createSchedule({
      agentId: agent.id,
      name: "Morning brief",
      prompt: "Brief me",
      cron: "0 7 * * *",
      timezone: "UTC",
      runAt: null,
      enabled: true,
    });

    execution("owner-1");
    execution("task-1", schedule.id);
    execution(`delegate:${other.id}:t-1`);

    const source = (submissionIds: string[]) =>
      memorySourceOf(store, agent.id, {
        groupId: null,
        submissionIds,
        reviewOf: null,
      });

    expect(source(["owner-1"])).toEqual({ kind: "chat" });
    expect(source(["owner-1", "task-1"])).toEqual({
      kind: "task",
      scheduleId: schedule.id,
      name: "Morning brief",
    });
    expect(source([`delegate:${other.id}:t-1`])).toEqual({
      kind: "bot",
      agentId: other.id,
      name: "Grace",
    });
    expect(source(["unknown"])).toEqual({ kind: "chat" });
  });

  test("keeps group turns out of shared memory", () => {
    const group: MemoryContext = {
      groupId: "group-1",
      submissionIds: [],
      reviewOf: null,
    };

    const chat: MemoryContext = {
      groupId: null,
      submissionIds: [],
      reviewOf: null,
    };

    expect(() => assertOwnMemoryInGroup(group, true)).toThrow(
      "save to your own memory",
    );
    expect(() => assertOwnMemoryInGroup(group, false)).not.toThrow();
    expect(() => assertOwnMemoryInGroup(chat, true)).not.toThrow();
  });
});

test("the memory tool reports where it runs", async () => {
  const agent: Agent = {
    ...input("Ada"),
    id: "00000000-0000-4000-8000-000000000601",
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };

  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });

  faux.setResponses(
    Array.from({ length: 4 }, (_, i) =>
      i % 2 === 0
        ? fauxAssistantMessage(
            fauxToolCall("memory", { action: "create", content: "fact" }),
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage([fauxText("Saved.")]),
    ),
  );

  const models = createModels();
  models.setProvider(faux.provider);
  const contexts: MemoryContext[] = [];

  const runtime = new AgentRuntime(temp(), {
    models,
    createMemory: (_agentId, content, _shared, context) => {
      contexts.push(context);

      return { id: "m", content };
    },
  });

  cleanups.push(() => runtime.close());
  const chat = await runtime.openChat(agent);
  const group = await runtime.openGroupConversation(agent, "group-1");

  for (const conversation of [chat, group]) {
    const submission = await runtime.submit(agent, conversation, "remember");
    await runtime.wait(submission, agent);
  }

  expect(contexts).toEqual([
    { groupId: null, submissionIds: [expect.any(String)], reviewOf: null },
    {
      groupId: "group-1",
      submissionIds: [expect.any(String)],
      reviewOf: null,
    },
  ]);
});
