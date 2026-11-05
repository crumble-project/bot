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
import { Effect, Exit } from "effect";
import type { Agent } from "../shared/domain";
import { assertOwnMemoryInGroup, memorySourceOf } from "./memory-sources";
import { AgentRuntime, type MemoryContext } from "../bots/runtime";
import { Store } from "../../test/support/store";
import { defaultAvatarDefinition } from "../contract/avatar";

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
      store.runtime.runSync(
        memorySourceOf(agent.id, {
          groupId: group.id,
          submissionIds: [],
          reviewOf: null,
        }),
      ),
    ).toEqual({ kind: "group", groupId: group.id, name: "Trip" });
  });

  test("takes the newest input of a chat run", () => {
    const { store, agent, other, execution } = setup();

    const schedule = store.createSchedule({
      agentId: agent.id,
      name: "Morning brief",
      kind: "prompt",
      command: null,
      timeoutSeconds: 600,
      notify: true,
      prompt: "Brief me",
      cron: "0 7 * * *",
      timezone: "UTC",
      runAt: null,
      eventSourceId: null,
      enabled: true,
    });

    execution("owner-1");
    execution("task-1", schedule.id);
    execution(`delegate:${other.id}:t-1`);

    const source = (submissionIds: string[]) =>
      store.runtime.runSync(
        memorySourceOf(agent.id, {
          groupId: null,
          submissionIds,
          reviewOf: null,
        }),
      );

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

  test("a job question relayed to a bot comes from the bot whose job asks", () => {
    const { store, agent, other, execution } = setup();
    const requestId = `job-question:${other.id}:question-1`;

    execution(requestId);

    expect(
      store.runtime.runSync(
        memorySourceOf(agent.id, {
          groupId: null,
          submissionIds: [requestId],
          reviewOf: null,
        }),
      ),
    ).toEqual({ kind: "bot", agentId: other.id, name: "Grace" });
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

    const check = (context: MemoryContext, shared: boolean) =>
      Effect.runSyncExit(assertOwnMemoryInGroup(context, shared));

    expect(String(check(group, true))).toContain("save to your own memory");
    expect(check(group, false)).toEqual(Exit.void);
    expect(check(chat, true)).toEqual(Exit.void);
  });
});

test("the memory tool reports where it runs", async () => {
  const agent: Agent = {
    ...input("Ada"),
    avatar: defaultAvatarDefinition("ada"),
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

  const submissions: string[] = [];

  for (const conversation of [chat, group]) {
    const submission = await runtime.submit(agent, conversation, "remember");

    submissions.push(submission);
    await runtime.wait(submission, agent);
  }

  expect(contexts).toEqual([
    { groupId: null, submissionIds: [submissions[0]!], reviewOf: null },
    { groupId: "group-1", submissionIds: [submissions[1]!], reviewOf: null },
  ]);
});
