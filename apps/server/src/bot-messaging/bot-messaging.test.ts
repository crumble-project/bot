import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotMessaging } from "./bot-messaging";
import { CrumbleService } from "../bots/service";
import type { Agent } from "../shared/domain";
import { Store } from "../shared/store";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  type Context,
} from "@earendil-works/chord/context";

const ids = {
  source: "00000000-0000-4000-8000-000000000101",
  target: "00000000-0000-4000-8000-000000000102",
  disabled: "00000000-0000-4000-8000-000000000103",
  other: "00000000-0000-4000-8000-000000000104",
};

const dirs: string[] = [];

const input = (name: string, delegates: string[] = [], enabled = true) => ({
  name,
  avatar: "sparkles",
  description: `${name} description`,
  instructions: "Answer plainly",
  provider: "openai" as const,
  model: "gpt-4.1",
  enabled,
  tools: ["delegate"],
  skills: [],
  mcpServers: [],
  delegates,
});

function setup(
  wait: (
    submission?: string,
    context?: Context,
  ) => Promise<{
    status: "done" | "unanswered";
    reason?: string;
    detail?: string;
  }> = async () => ({ status: "done" }),
) {
  const dir = mkdtempSync(join(tmpdir(), "bot-messaging-"));
  dirs.push(dir);
  let conversation = 0;

  const runtime: any = {
    openChat: async (agent: Agent) => `${agent.id}:${++conversation}`,
    submit: async (
      _agent: Agent,
      _conversation: string,
      _message: string,
      requestId: string,
    ) => `submission:${requestId}`,
    wait: (submission: string, _agent: Agent, context: Context) =>
      awaitWithContext(
        wait(submission, context),
        context ?? BACKGROUND_CONTEXT,
      ),
    response: async (
      _agent: Agent,
      _conversation: string,
      submission: string,
    ) => [`answer:${submission}`],
    abort: async () => {},
    close: async () => {},
    recordBotMessage: async () => {},
  };

  const store = new Store(dir);
  const service = new CrumbleService(store, runtime);
  const source = store.createAgent(input("Source", [ids.target]), ids.source);
  const target = store.createAgent(input("Bot2"), ids.target);
  store.createAgent(input("Disabled", [ids.target], false), ids.disabled);
  store.createAgent(input("Other", [ids.target]), ids.other);

  return {
    store,
    service,
    source,
    target,
    messaging: new BotMessaging(service),
  };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

test("recipients exposes every other enabled bot", async () => {
  const { messaging, store } = setup();
  expect(messaging.recipients(ids.source)).toEqual([
    { id: ids.target, name: "Bot2", description: "Bot2 description" },
    { id: ids.other, name: "Other", description: "Other description" },
  ]);
  store.close();
});

test("rejects disabled and ambiguous name recipients", async () => {
  const { messaging, store } = setup();
  store.updateAgent(ids.source, { delegates: [ids.target, ids.disabled] });
  await expect(
    messaging.send(ids.source, {
      recipient: "Disabled",
      message: "hello",
      requestId: "disabled-1",
    }),
  ).rejects.toThrow(/enabled/i);
  store.createAgent(input("Bot2"), "00000000-0000-4000-8000-000000000105");
  store.updateAgent(ids.source, {
    delegates: [ids.target, "00000000-0000-4000-8000-000000000105"],
  });
  await expect(
    messaging.send(ids.source, {
      recipient: "Bot2",
      message: "hello",
      requestId: "ambiguous-1",
    }),
  ).rejects.toThrow(/ambiguous/i);
  store.close();
});

test("send resolves IDs, exact names, and @mentions and deduplicates task requests", async () => {
  const { messaging, store } = setup();

  const first = await messaging.send(ids.source, {
    recipient: "@Bot2",
    message: "How do you feel?",
    requestId: "ask-1",
  });

  const duplicate = await messaging.send(ids.source, {
    recipient: ids.target,
    message: "How do you feel?",
    requestId: "ask-1",
  });

  expect(duplicate.executionId).toBe(first.executionId);
  expect(first).toMatchObject({ agentId: ids.target, agent: "Bot2" });
  await expect(
    messaging.send(ids.source, {
      recipient: "Bot2",
      message: "Different task",
      requestId: "ask-1",
    }),
  ).rejects.toThrow(/different.*message|collision/i);
  store.close();
});

test("a replay keeps the original bot after its name changes", async () => {
  const { messaging, store } = setup();

  const first = await messaging.send(ids.source, {
    recipient: "@Bot2",
    message: "hello",
    requestId: "renamed",
  });

  store.updateAgent(ids.target, { name: "Renamed" });
  store.updateAgent(ids.other, { name: "Bot2" });
  store.updateAgent(ids.source, { delegates: [ids.target, ids.other] });

  const replay = await messaging.send(ids.source, {
    recipient: "@bot2",
    message: "hello",
    requestId: "renamed",
  });

  expect(replay.executionId).toBe(first.executionId);
  expect(replay.agentId).toBe(ids.target);
  expect(store.listExecutions(ids.other)).toHaveLength(0);
  store.close();
});

test("rejects reusing one source request for a different authorized recipient", async () => {
  const { messaging, store } = setup();

  const secondTarget = store.createAgent(
    input("Bot3"),
    "00000000-0000-4000-8000-000000000106",
  );

  store.updateAgent(ids.source, { delegates: [ids.target, secondTarget.id] });

  const first = await messaging.send(ids.source, {
    recipient: ids.target,
    message: "same request",
    requestId: "cross-target-1",
  });

  await expect(
    messaging.send(ids.source, {
      recipient: secondTarget.id,
      message: "same request",
      requestId: "cross-target-1",
    }),
  ).rejects.toThrow(/different bot message|collision/i);
  expect(store.listExecutions(ids.target)).toHaveLength(1);
  expect(store.listExecutions(secondTarget.id)).toHaveLength(0);
  expect(first.agentId).toBe(ids.target);
  store.close();
});

test("result waits for completion and rejects revoked or foreign receipts", async () => {
  let resolveWait!: (value: { status: "done" }) => void;

  const pending = new Promise<{ status: "done" }>(
    (resolve) => (resolveWait = resolve),
  );

  const { messaging, service, store } = setup(() => pending);

  const sent = await messaging.send(ids.source, {
    recipient: "Bot2",
    message: "Tell me how you feel",
    requestId: "ask-2",
  });

  const immediate = await messaging.result(ids.source, sent.executionId);
  expect(immediate.status).toMatch(/pending|running/);
  resolveWait({ status: "done" });

  const result = await messaging.result(ids.source, sent.executionId, {
    waitMs: 1000,
  });

  expect(result).toMatchObject({
    executionId: sent.executionId,
    agentId: ids.target,
    status: "done",
  });
  expect(result.response).toEqual([
    `answer:submission:delegate:${ids.source}:ask-2`,
  ]);
  store.updateAgent(ids.source, { tools: [] });
  await expect(messaging.result(ids.source, sent.executionId)).rejects.toThrow(
    /receipt|permission|revoked|turned off/i,
  );
  await expect(messaging.result(ids.other, sent.executionId)).rejects.toThrow(
    /receipt|permission|source/i,
  );
  await service.close();
});

test("result returns durable failure and cancellation states", async () => {
  const {
    messaging,
    service: _service,
    store,
  } = setup(async () => ({
    status: "unanswered",
    reason: "target failed",
    detail: "target failed",
  }));

  const failed = await messaging.send(ids.source, {
    recipient: "Bot2",
    message: "fail",
    requestId: "ask-3",
  });

  const failure = await messaging.result(ids.source, failed.executionId, {
    waitMs: 1000,
  });

  expect(failure).toMatchObject({ status: "failed", error: "target failed" });

  let resolveCancelled!: (value: { status: "done" }) => void;

  const cancelledWait = new Promise<{ status: "done" }>(
    (resolve) => (resolveCancelled = resolve),
  );

  const cancelledMessaging = setup(async () => cancelledWait);

  const cancelled = await cancelledMessaging.messaging.send(ids.source, {
    recipient: "Bot2",
    message: "cancel",
    requestId: "ask-4",
  });

  const cancelledService = cancelledMessaging.service;
  await cancelledService.abort((await cancelledService.chat(ids.target)).id);

  const cancellation = await cancelledMessaging.messaging.result(
    ids.source,
    cancelled.executionId,
  );

  expect(cancellation.status).toBe("cancelled");
  resolveCancelled({ status: "done" });
  await cancelledService.close();
  store.close();
});

test("timeout and caller cancellation stop only the waiter", async () => {
  let resolveWait!: (value: { status: "done" }) => void;

  const pending = new Promise<{ status: "done" }>(
    (resolve) => (resolveWait = resolve),
  );

  const { messaging, store } = setup(async () => pending);

  const sent = await messaging.send(ids.source, {
    recipient: "Bot2",
    message: "wait",
    requestId: "ask-5",
  });

  const timed = await messaging.result(ids.source, sent.executionId, {
    waitMs: 10,
  });

  expect(timed.status).toMatch(/pending|running/);
  const controller = new AbortController();

  const waiter = messaging.result(ids.source, sent.executionId, {
    waitMs: 1000,
    // SAFETY: The result API accepts this minimal context fixture.
    context: { abortSignal: controller.signal } as Context,
  });

  controller.abort();
  await expect(waiter).rejects.toThrow();
  resolveWait({ status: "done" });

  const finished = await messaging.result(ids.source, sent.executionId, {
    waitMs: 1000,
  });

  expect(finished.status).toBe("done");
  store.close();
});

test("concurrent opposing asks cannot admit a delegation cycle", async () => {
  let resolveWait!: (value: { status: "done" }) => void;

  const pending = new Promise<{ status: "done" }>(
    (resolve) => (resolveWait = resolve),
  );

  const { messaging, service, store } = setup(async () => pending);
  store.updateAgent(ids.target, { delegates: [ids.source] });

  const results = await Promise.allSettled([
    messaging.send(ids.source, {
      recipient: ids.target,
      message: "A asks B",
      requestId: "cycle-a",
    }),
    messaging.send(ids.target, {
      recipient: ids.source,
      message: "B asks A",
      requestId: "cycle-b",
    }),
  ]);

  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect(
    store.listExecutions(ids.source).length +
      store.listExecutions(ids.target).length,
  ).toBe(1);
  resolveWait({ status: "done" });
  await service.close();
});
