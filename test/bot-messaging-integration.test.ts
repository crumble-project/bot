import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime } from "../src/runtime";
import { Store } from "../src/store";
import { CrumbleService } from "../src/service";
import { coordinationExtension } from "../src/coordination";
import { BotMessaging } from "../src/bot-messaging";

test("a real faux turn asks another bot and only exposes its answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-messaging-e2e-"));
  const sourceId = "00000000-0000-4000-8000-000000000111";
  const targetId = "00000000-0000-4000-8000-000000000112";
  try {
    const sourceFaux = fauxProvider({
      provider: "faux",
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
      provider: "faux",
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
    const models = (agent: { id: string }) => {
      const selected = createModels();
      selected.setProvider(
        agent.id === sourceId ? sourceFaux.provider : targetFaux.provider,
      );
      return selected;
    };
    const store = new Store(dir);
    const source = store.createAgent(
      {
        name: "Source",
        avatar: "bot",
        description: "",
        instructions: "Ask when needed",
        provider: "faux" as any,
        model: "test",
        enabled: true,
        folder: "Personal",
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
        avatar: "bot",
        description: "",
        instructions: "Answer honestly",
        provider: "faux" as any,
        model: "test",
        enabled: true,
        folder: "Personal",
        tools: [],
        skills: [],
        mcpServers: [],
        delegates: [],
      },
      targetId,
    );
    let service!: CrumbleService;
    const runtime = new AgentRuntime(dir, {
      models,
      listMemory: (id) =>
        id === sourceId ? [{ id: "m", content: "private source memory" }] : [],
      extensions: (agent) => [coordinationExtension(agent, service)],
    });
    service = new CrumbleService(store, runtime);
    const execution = await service.sendChat(
      source.id,
      "Please ask @Bot2",
      "00000000-0000-4000-8000-000000000113",
    );
    await runtime.wait(execution.submissionId!, source);
    expect(targetCalls).toBe(1);
    expect(store.listExecutions(targetId)).toHaveLength(1);
    const targetHistory = await runtime.history(store.getAgent(targetId)!);
    const targetInput = targetHistory.messages.find(
      (message) => message.role === "user",
    );
    expect(targetInput?.origin).toMatchObject({
      kind: "bot",
      agentId: sourceId,
      name: "Source",
    });
    expect(
      targetHistory.messages.filter((message) => message.kind === "bot-message"),
    ).toEqual([
      expect.objectContaining({
        content: "How do you feel?",
        communication: expect.objectContaining({
          fromAgentId: sourceId,
          toAgentId: targetId,
          status: "sent",
        }),
      }),
    ]);
    const snapshot = await runtime.snapshot(source, execution.conversationId);
    expect(JSON.stringify(snapshot.messages)).toContain(
      "Bot2 says it feels fine.",
    );
    const targetExecution = store.listExecutions(targetId)[0]!;
    const messaging = new BotMessaging(service);
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
    ).toHaveLength(1);
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
    const reopened = new AgentRuntime(dir, { models });
    try {
      const persisted = (await reopened.history(source)).messages.filter(
        (message) => message.kind === "bot-message",
      );
      expect(persisted.map((message) => message.id)).toEqual(
        cards.map((message) => message.id),
      );
      expect(persisted[0]?.communication).toMatchObject({
        fromName: "Source",
        toName: "Bot2",
        status: "sent",
      });
      expect(persisted[1]?.communication).toMatchObject({
        fromName: "Bot2",
        toName: "Source",
        status: "done",
      });
      const persistedTarget = (
        await reopened.history(store.getAgent(targetId)!)
      ).messages.filter((message) => message.kind === "bot-message");
      expect(persistedTarget).toHaveLength(1);
      expect(persistedTarget[0]?.communication).toMatchObject({
        fromName: "Source",
        toName: "Bot2",
        status: "sent",
      });
    } finally {
      await reopened.close();
    }
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
