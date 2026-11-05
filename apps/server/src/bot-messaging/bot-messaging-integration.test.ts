import { expect, test } from "bun:test";
import { inertCredentials } from "../../test/support/job-wiring";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, type Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime } from "../bots/runtime";
import { codingPlugin } from "../jobs/coding";
import { DirectoryWorkspaces } from "../../test/support/jobs";
import { conversationEnv, jobExtensions } from "../plugins/plugins";
import { Store } from "../../test/support/store";
import { standaloneBots } from "../bots/bots-test-support";
import { coordinationExtension } from "./coordination";
import { standaloneMessaging } from "./bot-messaging-test-support";
import { accessOf, noServices } from "../shared/runner";
import { runtimeCallbacks } from "../../test/support/runtime-callbacks";
import { until } from "../../test/support/until";

test("a real faux turn asks another bot and only exposes its answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-messaging-e2e-"));
  const sourceId = "00000000-0000-4000-8000-000000000111";
  const targetId = "00000000-0000-4000-8000-000000000112";

  try {
    const sourceFaux = fauxProvider({
      provider: "faux-source",
      models: [{ id: "test" }],
    });

    sourceFaux.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).toContain(
          "private source memory",
        );

        return fauxAssistantMessage(
          fauxToolCall("ask_bot", {
            recipient: "@Bot2",
            message: "How do you feel?",
          }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("I feel fine.");

        return fauxAssistantMessage("Bot2 says it feels fine.");
      },
    ]);

    const targetFaux = fauxProvider({
      provider: "faux-target",
      models: [{ id: "test" }],
    });

    let targetCalls = 0;
    targetFaux.setResponses([
      (context) => {
        targetCalls++;
        expect(JSON.stringify(context.messages)).not.toContain(
          "private source memory",
        );

        return fauxAssistantMessage("I feel fine.");
      },
    ]);

    const models = createModels();
    models.setProvider(sourceFaux.provider);
    models.setProvider(targetFaux.provider);

    const store = new Store(dir);

    const source = store.createAgent(
      {
        name: "Source",
        description: "",
        instructions: "Ask when needed",
        // SAFETY: The faux provider is registered in the test model registry.
        provider: "faux-source" as any,
        model: "test",
        enabled: true,
        tools: ["delegate"],
        skills: [],
        mcpServers: [],
        delegates: [targetId],
      },
      sourceId,
    );

    store.createAgent(
      {
        name: "Bot2",
        description: "",
        instructions: "Answer honestly",
        // SAFETY: The faux provider is registered in the test model registry.
        provider: "faux-target" as any,
        model: "test",
        enabled: true,
        tools: [],
        skills: [],
        mcpServers: [],
        delegates: [],
      },
      targetId,
    );
    let service!: ReturnType<typeof standaloneBots<Store>>;

    const runtime = new AgentRuntime(
      dir,
      runtimeCallbacks({
        models,
        listMemory: (id) =>
          id === sourceId
            ? [{ id: "m", content: "private source memory" }]
            : [],
        extensions: (agent) => [
          coordinationExtension(agent, standaloneMessaging(service)),
        ],
      }),
    );

    service = standaloneBots(store, runtime);

    const execution = await service.sendChat(
      source.id,
      "Please ask @Bot2",
      "00000000-0000-4000-8000-000000000113",
    );

    await runtime.wait(execution.submissionId!, source);
    expect(targetCalls).toBe(1);
    expect(store.listExecutions(targetId)).toHaveLength(1);
    const targetExecution = store.listExecutions(targetId)[0]!;

    const sent = {
      executionId: targetExecution.id,
      fromAgentId: sourceId,
      fromName: "Source",
      toAgentId: targetId,
      toName: "Bot2",
      status: "sent" as const,
    };

    const targetHistory = await runtime.history(store.getAgent(targetId)!);

    const targetInput = targetHistory.messages.find(
      (message) => message.role === "user",
    );

    expect(targetInput?.origin).toEqual({
      kind: "bot",
      agentId: sourceId,
      name: "Source",
    });
    expect(
      targetHistory.messages.filter(
        (message) => message.kind === "bot-message",
      ),
    ).toEqual([]);
    const snapshot = await runtime.snapshot(source, execution.conversationId);
    expect(JSON.stringify(snapshot.messages)).toContain(
      "Bot2 says it feels fine.",
    );

    const messaging = accessOf(standaloneMessaging(service), noServices, [
      "recipients",
    ]);

    const targetChat = await service.chat(targetId);
    let targetChanges = 0;

    const unsubscribeTarget = service.subscribe(targetChat.id, () => {
      targetChanges++;
    });

    const retryRequestId = targetExecution.requestId.replace(
      `delegate:${sourceId}:`,
      "",
    );

    const retried = await messaging.send(source.id, {
      recipient: targetId,
      message: "How do you feel?",
      requestId: retryRequestId,
    });

    expect(retried.executionId).toBe(targetExecution.id);
    expect(targetChanges).toBeGreaterThan(0);
    expect(
      (await runtime.history(store.getAgent(targetId)!)).messages.filter(
        (message) => message.kind === "bot-message",
      ),
    ).toHaveLength(0);
    unsubscribeTarget();

    const answer = await messaging.result(source.id, targetExecution.id, {
      waitMs: 1000,
    });

    expect(answer.response).toEqual(["I feel fine."]);
    const sourceHistory = await runtime.history(source);

    const cards = sourceHistory.messages.filter(
      (message) => message.kind === "bot-message",
    );

    expect(cards).toHaveLength(2);
    expect(
      cards.map((card) => ({
        content: card.content,
        status: card.communication?.status,
      })),
    ).toEqual([
      { content: "How do you feel?", status: "sent" },
      { content: "I feel fine.", status: "done" },
    ]);
    await messaging.result(source.id, targetExecution.id, { waitMs: 1000 });
    expect(
      (await runtime.history(source)).messages.filter(
        (message) => message.kind === "bot-message",
      ),
    ).toHaveLength(2);
    await runtime.close();
    const reopened = new AgentRuntime(dir, runtimeCallbacks({ models }));

    try {
      const persisted = (await reopened.history(source)).messages.filter(
        (message) => message.kind === "bot-message",
      );

      expect(persisted.map((message) => message.id)).toEqual(
        cards.map((message) => message.id),
      );
      expect(persisted.map((message) => message.communication)).toEqual([
        sent,
        {
          executionId: targetExecution.id,
          fromAgentId: targetId,
          fromName: "Bot2",
          toAgentId: sourceId,
          toName: "Source",
          status: "done",
        },
      ]);

      const persistedTarget = (
        await reopened.history(store.getAgent(targetId)!)
      ).messages.filter((message) => message.kind === "bot-message");

      expect(persistedTarget).toEqual([]);
    } finally {
      await reopened.close();
    }

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MAGNUM = "00000000-0000-4000-8000-000000000121";
const CODER = "00000000-0000-4000-8000-000000000122";

const textOf = (message: Message) =>
  (Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }]
  )
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const lastOf = (context: { messages: Message[] }) =>
  context.messages.findLast((message) => message.role !== "system")!;

const toolsOf = (context: { messages: Message[] }) =>
  context.messages.flatMap((message) =>
    message.role === "system"
      ? (message.toolsAdded ?? []).map((tool) => tool.name)
      : [],
  );

const magnumScript: FauxResponseFactory = (context) => {
  const last = lastOf(context);
  const text = textOf(last);
  const questionId = /questionId "([^"]+)"/.exec(text)?.[1];

  if (last.role === "user" && questionId)
    return toolCall("answer_job_question", { questionId, answer: "blue" });

  if (last.role === "toolResult") return fauxAssistantMessage("Done.");

  return toolCall("delegate", { agentId: CODER, task: "Build the site" });
};

const coderScript =
  (asking: Promise<void>): FauxResponseFactory =>
  async (context) => {
    const last = lastOf(context);
    const text = textOf(last);

    if (toolsOf(context).includes("ask_owner")) {
      if (last.role === "user" && text.includes("answered your question"))
        return fauxAssistantMessage(`Used ${text}`);

      await asking;

      return toolCall("ask_owner", {
        question: "Which color?",
        options: ["blue", "red"],
      });
    }

    if (text.startsWith("[coding job"))
      return fauxAssistantMessage("The job is finished.");

    if (last.role === "toolResult")
      return fauxAssistantMessage("Started the job.");

    return toolCall("coding", {
      action: "start",
      name: "builder",
      message: "Build the site",
    });
  };

async function delegatedBuild(asking: Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "bot-messaging-jobs-"));
  const workspace = join(dir, "workspace");
  await Bun.write(join(workspace, ".keep"), "");

  const faux = (name: string, steps: FauxResponseFactory) => {
    const provider = fauxProvider({
      provider: name,
      models: [{ id: "test" }],
    });

    provider.setResponses(Array.from({ length: 30 }, () => steps));

    return provider.provider;
  };

  const models = createModels();
  models.setProvider(faux("faux-magnum", magnumScript));
  models.setProvider(faux("faux-coder", coderScript(asking)));

  const store = new Store(dir);

  const bot = (name: string, tools: string[], delegates: string[]) => ({
    name,
    description: "",
    instructions: "",
    provider: `faux-${name.toLowerCase()}`,
    model: "test",
    enabled: true,
    tools,
    skills: [],
    mcpServers: [],
    delegates,
  });

  const magnum = store.createAgent(
    bot("Magnum", ["delegate"], [CODER]),
    MAGNUM,
  );

  const coder = store.createAgent(bot("Coder", ["coding"], []), CODER);

  const kinds =
    codingPlugin(
      new DirectoryWorkspaces(workspace),
      () => 900_000,
      inertCredentials,
    ).jobKinds ?? [];

  let service!: ReturnType<typeof standaloneBots<Store>>;

  const runtime = new AgentRuntime(
    dir,
    runtimeCallbacks({
      models,
      extensions: (agent) => [
        coordinationExtension(agent, standaloneMessaging(service)),
        ...jobExtensions(kinds, agent).chat,
      ],
      jobExtensions: (agent) => jobExtensions(kinds, agent).job,
      env: (agent, target, context) =>
        conversationEnv(kinds, agent, target, context),
    }),
  );

  service = standaloneBots(store, runtime);

  const messaging = accessOf(standaloneMessaging(service), noServices, [
    "recipients",
  ]);

  const stopRelay = kinds[0]!.onQuestion!(async (asked) => {
    await messaging.relayQuestion(asked);
  });

  const sent = await service.sendChat(
    magnum.id,
    "Have Coder build the site",
    "00000000-0000-4000-8000-000000000123",
  );

  await runtime.wait(sent.submissionId!, magnum);
  const delegation = store.listExecutions(CODER)[0]!;
  await runtime.wait(delegation.submissionId!, coder);

  const coderMessages = async () =>
    (await runtime.history(store.getAgent(CODER)!)).messages;

  const close = async () => {
    stopRelay();
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return {
    store,
    service,
    runtime,
    messaging,
    magnum,
    coder,
    delegation,
    coderMessages,
    close,
  };
}

test("a delegation whose bot started a job stays pending until the job's report is answered", async () => {
  let ask!: () => void;
  const world = await delegatedBuild(new Promise((resolve) => (ask = resolve)));

  try {
    const { messaging, delegation } = world;

    await until(
      () => world.store.getExecution(delegation.id)?.status === "done",
    );

    expect(
      await messaging.result(MAGNUM, delegation.id, { waitMs: 200 }),
    ).toMatchObject({ status: "running", response: [] });

    ask();

    await until(
      async () =>
        (await messaging.result(MAGNUM, delegation.id)).status === "done",
    );

    const answer = await messaging.result(MAGNUM, delegation.id);

    expect(answer.response.at(-1)).toBe("The job is finished.");
    expect(answer.error).toBeNull();

    const cards = (await world.runtime.history(world.magnum)).messages
      .filter((message) => message.kind === "bot-message")
      .map((message) => message.communication?.status);

    expect(cards).toEqual(["sent", "done"]);
  } finally {
    await world.close();
  }
}, 20_000);

test("a job's question goes to the bot that delegated its task, whose answer resumes the job", async () => {
  const world = await delegatedBuild(Promise.resolve());

  try {
    const { store, runtime, service } = world;

    const relayed = async () =>
      (await runtime.history(store.getAgent(MAGNUM)!)).messages.find(
        (message) =>
          message.role === "user" && message.content.includes("Which color?"),
      );

    await until(async () => (await relayed()) !== undefined);
    expect((await relayed())?.origin).toEqual({
      kind: "bot",
      agentId: CODER,
      name: "Coder",
    });

    const card = (await world.coderMessages()).find(
      (message) => message.kind === "job-question",
    );

    expect(card?.content).toBe("Which color?");

    await until(async () =>
      (await world.coderMessages()).some(
        (message) =>
          message.origin?.kind === "coding" &&
          message.content ===
            "Used Magnum, the bot that delegated your task, answered your question: blue",
      ),
    );

    await expect(
      service.answerJob(CODER, "coding", {
        name: "builder",
        questionId: card!.jobQuestion!.id,
        text: "red",
      }),
    ).rejects.toThrow("The job no longer waits on this question");
    expect(
      store
        .listExecutions(MAGNUM)
        .filter((execution) => execution.requestId.startsWith("job-question:")),
    ).toHaveLength(1);
  } finally {
    await world.close();
  }
}, 20_000);

test("a job's question stays with the owner once the delegating bot may no longer message other bots", async () => {
  let ask!: () => void;
  const world = await delegatedBuild(new Promise((resolve) => (ask = resolve)));

  try {
    const { store, service } = world;
    store.updateAgent(MAGNUM, { tools: [] });
    ask();

    const card = async () =>
      (await world.coderMessages()).find(
        (message) => message.kind === "job-question",
      );

    await until(async () => (await card()) !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(store.listExecutions(MAGNUM)).toHaveLength(1);

    await service.answerJob(CODER, "coding", {
      name: "builder",
      questionId: (await card())!.jobQuestion!.id,
      text: "red",
    });

    await until(async () =>
      (await world.coderMessages()).some(
        (message) =>
          message.content === "Used The owner answered your question: red",
      ),
    );
  } finally {
    await world.close();
  }
}, 20_000);
