import { afterEach, expect, test } from "bun:test";
import { openGroupConversation } from "../group-chats/group-turns";
import { openReviewConversation } from "./review-conversation";
import type { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { standaloneLearningReview } from "./learning-review-test-support";
import { AgentRuntime } from "../bots/runtime";
import { standaloneBots } from "../bots/bots-test-support";
import { type LearnedActivity } from "../bots/bots";
import { standaloneSkills } from "../skills/skills-test-support";
import { BotMemory } from "../memory/bot-memory";
import { Store } from "../../test/support/store";
import { runtimeCallbacks } from "../../test/support/runtime-callbacks";

const dirs: string[] = [];
const services: ReturnType<typeof standaloneBots<Store>>[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();

  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function open(responses: FauxResponseStep[]) {
  const dir = mkdtempSync(join(tmpdir(), "bot-review-"));
  dirs.push(dir);

  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "chat" }, { id: "cheap" }],
  });

  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const store = new Store(dir);

  const memory = <A>(
    use: (memory: BotMemory["Service"]) => Effect.Effect<A, unknown>,
  ) => store.runtime.runPromise(BotMemory.use(use));

  const runtime = new AgentRuntime(
    dir,
    runtimeCallbacks({
      models,
      currentAgent: (agent) => store.getAgent(agent.id),
      skillLibrary: standaloneSkills(store),
      listMemory: (agentId) => memory((m) => m.list(agentId)),
      createMemory: (agentId, content, shared, context) =>
        memory((m) => m.create(agentId, content, shared, context)),
      updateMemory: (agentId, id, content, context) =>
        memory((m) => m.update(agentId, id, content, context)),
      deleteMemory: (agentId, id, context) =>
        memory((m) => m.delete(agentId, id, context)),
    }),
  );

  const service = standaloneBots(store, runtime);
  services.push(service);
  const learned: LearnedActivity[] = [];

  const reviews = standaloneLearningReview(service);

  service.onActivity((event) => {
    if (event.type === "learned") learned.push(event);
  });

  service.onSettled((execution) => reviews.afterExecution(execution));

  return { store, runtime, service, reviews, learned, faux };
}

async function settle(
  service: ReturnType<typeof standaloneBots<Store>>,
  executionId: string,
) {
  for (let i = 0; i < 300; i++) {
    const status = service.store.getExecution(executionId)?.status;

    if (status !== "pending" && status !== "running") return status;
    await Bun.sleep(10);
  }

  throw new Error("Execution did not settle");
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 300 && !condition(); i++) await Bun.sleep(10);

  expect(condition()).toBe(true);
}

const agentInput = {
  name: "Learner",
  description: "",
  instructions: "Answer",
  provider: "faux",
  model: "chat",
  enabled: true,
  tools: [],
  skills: [{ name: "Research", instructions: "Check sources" }],
  mcpServers: [],
  delegates: [],
};

test("a tool-heavy turn is reviewed on the review model, which patches a skill and reports the change", async () => {
  const prompts: string[] = [];
  const modelsUsed: string[] = [];

  const capture =
    (message: AssistantMessage): FauxResponseFactory =>
    (context, _options, _state, model) => {
      prompts.push(JSON.stringify(context.messages));
      modelsUsed.push(model.id);

      return message;
    };

  const { store, service, learned } = open([
    // The owner's turn: one tool round, then an answer.
    capture(
      fauxAssistantMessage(
        [fauxToolCall("skill", { action: "view", name: "Research" })],
        { stopReason: "toolUse" },
      ),
    ),
    capture(fauxAssistantMessage("Here is what I found.")),
    // The review: read the skill, patch it, done.
    capture(
      fauxAssistantMessage(
        [fauxToolCall("skill", { action: "view", name: "Research" })],
        { stopReason: "toolUse" },
      ),
    ),
    capture(
      fauxAssistantMessage(
        [
          fauxToolCall("skill_manage", {
            operations: [
              {
                action: "patch",
                name: "Research",
                oldString: "Check sources",
                newString: "Check primary sources first",
              },
            ],
          }),
        ],
        { stopReason: "toolUse" },
      ),
    ),
    capture(fauxAssistantMessage("Patched Research.")),
  ]);

  const agent = store.createAgent({
    ...agentInput,
    review: { enabled: true, skillThreshold: 1, memoryThreshold: 10 },
    reviewModel: { provider: "faux", model: "cheap" },
  });

  const execution = await service.sendChat(agent.id, "Look this up", uuid(1));
  expect(await settle(service, execution.id)).toBe("done");
  await until(() => learned.length === 1);

  expect(learned[0]).toMatchObject({
    type: "learned",
    agentId: agent.id,
    executionId: execution.id,
    changes: [{ target: "skill", action: "update", name: "Research" }],
  });
  expect(store.listSkills(agent.id)[0]?.instructions).toBe(
    "Check primary sources first",
  );

  const change = store.getChange(learned[0]!.changes[0]!.changeId);
  expect(change).toMatchObject({
    actor: "review",
    source: { executionId: execution.id },
  });
  expect(store.reviewCounters(agent.id)).toEqual({ skill: 0, memory: 1 });
  expect(store.listPendingReviews()).toEqual([]);

  // The review ran on the cheap model, with only the skill tools and the turn as its input.
  expect(modelsUsed.slice(2)).toEqual(["cheap", "cheap", "cheap"]);
  expect(prompts[2]).toContain("reviewing one of your own finished turns");
  expect(prompts[2]).toContain(
    "The turn to review:\\n\\nOwner:\\nLook this up",
  );
  expect(prompts[2]).toContain(
    "Your standing instructions in the owner's chat",
  );
  expect(prompts[2]).toContain("Tool call skill:");
  expect(prompts[2]).toContain('"name":"skill_manage"');
  expect(prompts[2]).not.toContain('"name":"memory"');
  expect(prompts[2]).not.toContain('"name":"history_search"');

  // The review conversation stays out of the bot chat.
  const chat = await service.chatSnapshot(agent.id);
  expect(JSON.stringify(chat.messages)).not.toContain("Patched Research");

  // The result is kept for clients that reconnect.
  expect(store.listReviewResults(agent.id)).toMatchObject([
    {
      executionId: execution.id,
      changes: [{ id: learned[0]!.changes[0]!.changeId, actor: "review" }],
    },
  ]);
});

test("a review stops before its input budget is exceeded and leaves no changes behind", async () => {
  const { store, service, learned } = open([
    fauxAssistantMessage(
      [fauxToolCall("skill", { action: "view", name: "Research" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Found it."),
    // The review's first request already exceeds a 1000-token budget, so none of these should run.
    fauxAssistantMessage(
      [fauxToolCall("skill", { action: "view", name: "Research" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Nothing to save."),
  ]);

  const agent = store.createAgent({
    ...agentInput,
    review: {
      enabled: true,
      skillThreshold: 1,
      memoryThreshold: 10,
      maxInputTokens: 1000,
    },
  });

  const execution = await service.sendChat(agent.id, "Look this up", uuid(1));
  expect(await settle(service, execution.id)).toBe("done");
  await until(() => store.listPendingReviews().length === 0);
  await Bun.sleep(50);
  expect(learned).toEqual([]);
  expect(store.listChangesOfExecution(execution.id, "review")).toEqual([]);
  expect(store.listSkills(agent.id)[0]?.instructions).toBe("Check sources");
});

test("only the rounds after a turn's last skill write count towards the next review", async () => {
  const { store, service, learned } = open([
    fauxAssistantMessage(
      [fauxToolCall("skill", { action: "view", name: "Research" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [fauxToolCall("skill", { action: "view", name: "Research" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall("skill_manage", {
          operations: [
            {
              action: "patch",
              name: "Research",
              oldString: "Check sources",
              newString: "Check sources twice",
            },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [fauxToolCall("skill", { action: "view", name: "Research" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);

  const agent = store.createAgent({
    ...agentInput,
    review: { enabled: true, skillThreshold: 3, memoryThreshold: 3 },
  });

  const execution = await service.sendChat(agent.id, "Learn", uuid(1));
  expect(await settle(service, execution.id)).toBe("done");
  await Bun.sleep(100);
  // Four rounds in total, one after the skill write: no review, and the skill counter restarted at the write.
  expect(learned).toEqual([]);
  expect(store.reviewCounters(agent.id)).toEqual({ skill: 1, memory: 4 });
});

test("turns below the threshold are not reviewed, scheduled runs count like chat turns, and a restart drops a pending review", async () => {
  const { store, service, runtime, reviews, learned } = open([
    fauxAssistantMessage("plain answer"),
    fauxAssistantMessage(
      [fauxToolCall("skill", { action: "view", name: "Research" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [fauxToolCall("skill", { action: "view", name: "Research" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("another plain answer"),
  ]);

  const agent = store.createAgent({
    ...agentInput,
    review: { enabled: true, skillThreshold: 2, memoryThreshold: 2 },
  });

  const first = await service.sendChat(agent.id, "hello", uuid(1));
  expect(await settle(service, first.id)).toBe("done");
  await Bun.sleep(50);
  expect(learned).toEqual([]);
  expect(store.reviewCounters(agent.id)).toEqual({ skill: 0, memory: 0 });

  // A scheduled run counts like a chat turn: its two tool rounds reach the skill threshold, so a review runs and resets
  // that counter. Memory keeps counting because this bot has no memory tool to review with.
  const schedule = store.createSchedule({
    agentId: agent.id,
    name: "Daily",
    kind: "prompt",
    command: null,
    timeoutSeconds: 600,
    notify: true,
    prompt: "do it",
    cron: null,
    timezone: "UTC",
    runAt: null,
    eventSourceId: null,
    enabled: true,
  });

  const task = await service.dispatch(agent.id, "do it", uuid(2), schedule.id);
  expect(await settle(service, task.id)).toBe("done");
  await Bun.sleep(50);
  expect(learned).toEqual([]);
  expect(store.reviewCounters(agent.id)).toEqual({ skill: 0, memory: 2 });

  // A review left pending by a crash is aborted and forgotten on recovery.
  const conversation = await openReviewConversation(
    runtime,
    agent,
    first,
    { skills: true, memory: false },
    100000,
  );

  store.addPendingReview(first.id, agent.id, conversation);
  await reviews.recover();
  expect(store.listPendingReviews()).toEqual([]);
});

test("a review of a group turn cannot change shared memory, while a review of a chat turn can", async () => {
  const turn = (answer: string, shared: string): FauxResponseStep[] => [
    fauxAssistantMessage([fauxToolCall("memory", { action: "list" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(answer),
    fauxAssistantMessage(
      [
        fauxToolCall("memory", {
          action: "create",
          content: shared,
          shared: true,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ];

  const { store, runtime, service, faux } = open([
    ...turn("For the owner.", "from the chat"),
    ...turn("For the group.", "from the group"),
  ]);

  const agent = store.createAgent({
    ...agentInput,
    tools: ["memory"],
    sharedMemory: true,
    review: { enabled: true, skillThreshold: 10, memoryThreshold: 1 },
  });

  const shared = async () =>
    (
      await store.runtime.runPromise(BotMemory.use((m) => m.list(agent.id)))
    ).flatMap((memory) => (memory.shared ? [memory.content] : []));

  const chatTurn = await service.sendChat(agent.id, "hello", uuid(1));
  expect(await settle(service, chatTurn.id)).toBe("done");
  await until(() => faux.getPendingResponseCount() === 4);
  await until(() => store.listPendingReviews().length === 0);
  expect(await shared()).toEqual(["from the chat"]);

  const group = await openGroupConversation(runtime, agent, "group-1");
  store.createConversation({ agentId: agent.id, title: "Group" }, group);
  const groupTurn = await service.send(group, "hello", "group-turn:1");
  expect(await settle(service, groupTurn.id)).toBe("done");
  await until(() => faux.getPendingResponseCount() === 0);
  await until(() => store.listPendingReviews().length === 0);
  expect(await shared()).toEqual(["from the chat"]);
});
