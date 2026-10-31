import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { productLayer } from "../app/product-layer";
import { handleApiError } from "../app/api";
import { AgentRepository } from "../bots/agent-repository";
import { Bots } from "../bots/bots";
import { ConversationRepository } from "../bots/conversation-repository";
import { ExecutionRepository } from "../bots/execution-repository";
import { BotRuntime, type AgentRuntime } from "../bots/runtime";
import { SettingsRepository } from "../shared/settings-repository";
import { SecretRepository } from "../credentials/secret-repository";
import { contractApp } from "../contract/api-contract";
import { Plugins } from "../plugins/plugins";
import { agentInput, type Execution } from "../shared/domain";
import {
  GatewayTransportError,
  type ChatAdapter,
  type GatewayConnection,
  type GatewayMessage,
} from "./adapter";
import {
  defaultGatewayConfig,
  gatewayConfigInput,
  type GatewayConfig,
  gatewayResponse,
  gatewaysResponse,
} from "../contract/message-gateway";
import { registerGatewayRoutes } from "./gateway-api";
import { GatewayRepository } from "./gateway-repository";
import { MessageGateway } from "./message-gateway";
import { gatewayChunks, selectGatewayBot } from "./routing";

const folders: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
const ada = "00000000-0000-4000-8000-000000000001";
const grace = "00000000-0000-4000-8000-000000000002";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();

  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

const directory = () => {
  const folder = mkdtempSync(join(tmpdir(), "crumble-gateway-"));
  folders.push(folder);

  return folder;
};

async function fixture(
  folder = directory(),
  responseText = "associated answer",
  fakeClock = false,
) {
  const sent: Parameters<GatewayConnection["send"]>[0][] = [];
  const attempts: Parameters<GatewayConnection["send"]>[0][] = [];
  const tokens: string[] = [];
  const sendGates = new Map<string, Promise<void>>();
  const responseCalls: string[] = [];
  const submitted: { botId: string; text: string; requestId: string }[] = [];
  let closes = 0;
  let failSend = false;
  let sendError: Error | undefined;
  let hostCallbacks: Parameters<ChatAdapter["connect"]>[0] | undefined;
  let failConnect = false;
  let nextStatus: Execution["status"] = "done";
  let responseGate: Promise<void> | undefined;
  let connectGate: Promise<void> | undefined;
  const connectStarted = Promise.withResolvers<void>();
  let onMessage: ((message: GatewayMessage) => Promise<void>) | undefined;

  const adapter: ChatAdapter = {
    id: "test-platform",
    label: "Test platform",
    secretKey: "test-platform:token",
    maxMessageLength: 60,
    async connect(host) {
      hostCallbacks = host;
      tokens.push(host.token);
      connectStarted.resolve();

      if (connectGate) await connectGate;

      if (failConnect) throw new Error("secret must never appear in status");
      onMessage = (message) => host.onMessage(message);
      host.onStatus("connected");

      let connectionClosed = false;

      return {
        async send(input) {
          attempts.push(input);
          await sendGates.get(input.channelId);

          if (connectionClosed) throw new Error("Connection closed");

          if (sendError) throw sendError;

          if (failSend) throw new Error("private transport details");
          sent.push(input);

          return `out-${sent.length}`;
        },
        async close() {
          connectionClosed = true;
          closes++;
        },
      };
    },
  };

  const dependencies = Layer.mergeAll(
    Layer.succeed(Plugins, [{ id: "test-platform", chatAdapters: [adapter] }]),
    // SAFETY: MessageGateway only invokes response on the runtime test double.
    Layer.succeed(BotRuntime, {
      async response(_agent, _conversationId, submissionId) {
        responseCalls.push(submissionId);
        await responseGate;

        return [responseText];
      },
    } as AgentRuntime),
    Layer.effect(
      Bots,
      Effect.gen(function* () {
        const executions = yield* ExecutionRepository;
        const conversations = yield* ConversationRepository;

        const sendChat = Effect.fnUntraced(function* (
          botId: string,
          text: string,
          requestId: string,
        ) {
          submitted.push({ botId, text, requestId });

          const conversation = yield* conversations.create({
            agentId: botId,
            title: "Chat",
          });

          return yield* executions.create({
            agentId: botId,
            conversationId: conversation.id,
            requestId,
            submissionId: crypto.randomUUID(),
            scheduleId: null,
            prompt: text,
            status: nextStatus,
            error: null,
          });
        });

        const unexpected = () =>
          Effect.die("Unexpected gateway bot service call");

        const unsubscribe = () => () => {};

        return Bots.of({
          sendChat,
          agent: unexpected,
          conversation: unexpected,
          subscribe: unsubscribe,
          onActivity: unsubscribe,
          onSettled: unsubscribe,
          agentPreviews: unexpected(),
          announceJobAnswer: unexpected,
          announce: unexpected,
          snapshot: unexpected,
          chat: unexpected,
          recordBotMessage: unexpected,
          chatSnapshot: unexpected,
          history: unexpected,
          codingJobs: unexpected,
          codingJobHistory: unexpected,
          desktopJobs: unexpected,
          desktopJobHistory: unexpected,
          notice: unexpected,
          send: unexpected,
          dispatch: unexpected,
          recover: unexpected(),
          compact: unexpected,
          abortChat: unexpected,
          abort: unexpected,
          deleteAgent: unexpected,
        });
      }),
    ),
  ).pipe(Layer.provideMerge(productLayer(folder)));

  const runtime = ManagedRuntime.make(
    MessageGateway.layer.pipe(
      Layer.provideMerge(dependencies),
      Layer.provideMerge(fakeClock ? TestClock.layer() : Layer.empty),
    ),
  );

  let disposed = false;

  const close = async () => {
    if (disposed) return;
    disposed = true;
    await runtime.dispose();
  };

  cleanups.push(close);
  const gateway = await runtime.runPromise(MessageGateway);
  await runtime.runPromise(
    AgentRepository.use((agents) =>
      Effect.gen(function* () {
        if (!(yield* agents.get(ada)))
          yield* agents.create(agentInput.parse({ name: "Ada" }), ada);

        if (!(yield* agents.get(grace)))
          yield* agents.create(agentInput.parse({ name: "Grace" }), grace);
      }),
    ),
  );

  const config: GatewayConfig = {
    ...defaultGatewayConfig(),
    enabled: true,
    defaultBotId: ada,
    ownerId: "owner",
    allowedChannelIds: ["channel"],
    aliases: [{ handle: "other", botId: grace }],
  };

  const message = (
    id: string,
    extra: Partial<GatewayMessage> = {},
  ): GatewayMessage => ({
    id,
    channelId: "channel",
    senderId: "owner",
    text: "hello",
    isDirectMessage: false,
    ...extra,
  });

  const tick = async () => {
    await runtime.runPromise(gateway.tick);

    for (let turn = 0; turn < 5; turn++)
      await new Promise((resolve) => setImmediate(resolve));
  };

  const update = (next = config) =>
    runtime.runPromise(gateway.update(adapter.id, next));

  const receive = (input: GatewayMessage) =>
    runtime.runPromise(gateway.receive(adapter.id, input));

  const token = (value: string) =>
    runtime.runPromise(
      SecretRepository.use((secrets) => secrets.set(adapter.secretKey, value)),
    );

  await token("first-token");

  return {
    folder,
    runtime,
    gateway,
    config,
    adapter,
    sent,
    attempts,
    sendGates,
    tokens,
    submitted,
    responseCalls,
    message,
    receive,
    tick,
    update,
    token,
    close,
    connectStarted: connectStarted.promise,
    get host() {
      return hostCallbacks!;
    },
    set responseGate(value: Promise<void> | undefined) {
      responseGate = value;
    },
    set sendError(value: Error | undefined) {
      sendError = value;
    },
    get closes() {
      return closes;
    },
    set failSend(value: boolean) {
      failSend = value;
    },
    set failConnect(value: boolean) {
      failConnect = value;
    },
    set nextStatus(value: Execution["status"]) {
      nextStatus = value;
    },
    set connectGate(value: Promise<void> | undefined) {
      connectGate = value;
    },
    get onMessage() {
      return onMessage;
    },
  };
}

test("a connection resolving after its timeout is closed and cannot submit messages", async () => {
  const f = await fixture();
  await f.update();
  const gate = Promise.withResolvers<void>();
  f.connectGate = gate.promise;
  await Effect.runPromise(
    Effect.gen(function* () {
      const ticking = yield* Effect.forkChild(f.gateway.tick);
      yield* Effect.promise(() => f.connectStarted);
      yield* TestClock.adjust("16 seconds");
      yield* Fiber.join(ticking);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.closes).toBe(1);
  await f.onMessage!(f.message("late"));
  expect(
    await f.runtime.runPromise(
      GatewayRepository.use((repository) => repository.pending),
    ),
  ).toHaveLength(0);
});

test("gateway HTTP configuration validates input, hides credentials, and can disable deleted recipients", async () => {
  const f = await fixture();
  const app = contractApp();
  app.onError(handleApiError);
  registerGatewayRoutes({
    register: (definition, handler) =>
      app.on(definition.method, definition.getRoutingPath(), handler),
    messageGateway: f.gateway,
  });

  type GatewayTestInput = Omit<GatewayConfig, "enabled"> & {
    enabled: boolean | string;
  };

  const save = (config: GatewayTestInput, id = f.adapter.id) =>
    app.request(`/v1/message-gateways/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });

  const saved = await save(f.config);
  expect(saved.status).toBe(200);
  expect(gatewayResponse.parse(await saved.json()).config).toEqual(f.config);
  const listed = await app.request("/v1/message-gateways");
  const body = await listed.text();
  expect(gatewaysResponse.parse(JSON.parse(body)).gateways).toHaveLength(1);
  expect(body).not.toContain("first-token");
  expect((await save({ ...f.config, enabled: "yes" })).status).toBe(400);
  expect((await save(f.config, "missing")).status).toBe(404);
  await f.runtime.runPromise(
    AgentRepository.use((repository) => repository.delete(ada)),
  );
  expect((await save(f.config)).status).toBe(400);
  expect((await save({ ...f.config, enabled: false })).status).toBe(200);
});

test("a crash before saving execution ID recovers the original execution across another chat", async () => {
  const first = await fixture();
  await first.update();
  first.nextStatus = "running";
  await first.receive(first.message("crash"));
  await first.tick();

  const execution = (
    await first.runtime.runPromise(
      ExecutionRepository.use((repository) => repository.list(undefined)),
    )
  )[0]!;

  await first.runtime.runPromise(
    GatewayRepository.use((repository) =>
      Effect.gen(function* () {
        const [receipt] = yield* repository.pending;
        yield* repository.save({ ...receipt!, executionId: null });
      }),
    ),
  );
  await first.close();
  const reopened = await fixture(first.folder);
  await reopened.runtime.runPromise(
    ConversationRepository.use((repository) =>
      repository.create({ agentId: ada, title: "new app chat" }),
    ),
  );
  await reopened.runtime.runPromise(
    ExecutionRepository.use((repository) =>
      repository.update(execution.id, { status: "done" }),
    ),
  );
  await reopened.tick();
  expect(reopened.submitted).toHaveLength(0);
  expect(reopened.responseCalls).toEqual([execution.submissionId!]);
  expect(reopened.sent).toHaveLength(1);
});

test("authorization, routing, duplicate events, and concurrent passes submit once and preserve text", async () => {
  const f = await fixture();
  await f.receive(f.message("disabled"));
  await f.update();
  await f.receive(f.message("outsider", { senderId: "outsider" }));
  await f.receive(f.message("wrong-channel", { channelId: "private" }));
  await f.receive(f.message("dm", { isDirectMessage: true }));
  const input = f.message("prefix", { text: "@other original message" });
  await Promise.all([f.receive(input), f.receive(input)]);
  await Promise.all([f.tick(), f.tick()]);
  expect(f.submitted).toEqual([
    expect.objectContaining({ botId: grace, text: input.text }),
  ]);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]?.text).toBe("**Grace**\nassociated answer");
  expect(f.responseCalls).toHaveLength(1);
  await f.receive(f.message("reply", { replyTo: "out-1" }));
  await f.tick();
  await f.receive(
    f.message("override", { replyTo: "out-1", text: "@Ada override" }),
  );
  await f.tick();
  await f.receive(f.message("default"));
  await f.tick();
  expect(f.submitted.map((input) => input.botId)).toEqual([
    grace,
    grace,
    ada,
    ada,
  ]);

  const executions = await f.runtime.runPromise(
    ExecutionRepository.use((repository) => repository.list(undefined)),
  );

  expect(new Set(f.responseCalls)).toEqual(
    new Set(executions.map((entry) => entry.submissionId!)),
  );
  await f.receive(f.message("attachment", { hasAttachments: true }));
  await f.receive(f.message("unknown", { text: "@missing hello" }));

  for (let pass = 0; pass < 5; pass++) await f.tick();
  expect(f.submitted).toHaveLength(4);
  expect(f.sent.map((entry) => entry.text).join("")).toContain(
    "Attachments are not supported",
  );
  expect(f.sent.map((entry) => entry.text).join("")).toContain(
    "Unknown or ambiguous bot @missing",
  );
});

test("receipt selection and reply associations survive reopening the real product database", async () => {
  const first = await fixture();
  await first.update();
  await first.receive(
    first.message("pending", { text: "@other keep original" }),
  );
  await first.close();
  const reopened = await fixture(first.folder);
  await reopened.update({
    ...reopened.config,
    defaultBotId: ada,
    aliases: [{ handle: "other", botId: ada }],
  });
  await reopened.tick();
  expect(reopened.submitted[0]?.botId).toBe(grace);
  await reopened.close();
  const again = await fixture(first.folder);
  await again.receive(
    again.message("reply-after-restart", { replyTo: "out-1" }),
  );
  await again.tick();
  expect(again.submitted[0]?.botId).toBe(grace);
  await again.receive(
    again.message("pending", { text: "replayed altered event" }),
  );
  await again.tick();
  expect(again.submitted).toHaveLength(1);
});

test("long answers retain durable per-chunk progress and stable failed-send nonces after reopening", async () => {
  const first = await fixture(undefined, "answer ".repeat(40));
  await first.update();
  await first.receive(first.message("long"));
  await first.tick();
  first.failSend = true;
  await first.tick();
  expect(first.sent).toHaveLength(1);
  expect((await Effect.runPromise(first.gateway.list))[0]?.error).toContain(
    "delivery failed",
  );
  const failedNonce = first.attempts[1]!.nonce;
  await first.close();

  const reopened = await fixture(
    first.folder,
    "wrong response must not be read",
  );

  await reopened.runtime.runPromise(
    GatewayRepository.use((repository) =>
      Effect.gen(function* () {
        const [receipt] = yield* repository.pending;
        yield* repository.save({ ...receipt!, nextAttemptAt: 0 });
      }),
    ),
  );

  for (let pass = 0; pass < 10; pass++) await reopened.tick();
  expect(reopened.submitted).toHaveLength(0);
  expect(reopened.responseCalls).toHaveLength(0);
  expect(reopened.sent[0]?.nonce).toBe(failedNonce);
  expect(
    reopened.sent.every(
      (entry) => entry.text.length <= 60 && entry.nonce.length <= 25,
    ),
  ).toBe(true);
  expect(
    first.sent
      .concat(reopened.sent)
      .map((entry) => entry.text)
      .join(""),
  ).toBe(`**Ada**\n${"answer ".repeat(40)}`);
  expect((await Effect.runPromise(reopened.gateway.list))[0]).toMatchObject({
    pendingCount: 0,
    error: null,
  });
});

test("authorization revocation suspends accepted work and token replacement retires old callbacks and connections", async () => {
  const f = await fixture();
  await f.update();
  await f.tick();
  const oldCallback = f.onMessage!;
  await f.receive(f.message("suspended"));
  await f.update({ ...f.config, ownerId: null });
  await f.tick();
  expect(f.submitted).toHaveLength(0);
  await f.update();
  await f.token("replacement-token");
  await f.tick();
  expect(f.tokens).toEqual(["first-token", "first-token", "replacement-token"]);
  expect(f.closes).toBe(2);
  await oldCallback(f.message("stale"));
  await f.tick();
  expect(f.submitted).toHaveLength(1);
  await f.update({ ...f.config, enabled: false });
  await f.tick();
  expect(f.closes).toBe(3);
  expect((await Effect.runPromise(f.gateway.list))[0]?.status).toBe(
    "disconnected",
  );
  await f.close();
});

test("connection errors are sanitized, credential changes bypass retry delay, and failed executions do not resubmit", async () => {
  const f = await fixture();
  await f.update();
  f.failConnect = true;
  await f.tick();
  await f.tick();
  expect(f.tokens).toHaveLength(1);
  expect((await Effect.runPromise(f.gateway.list))[0]?.error).not.toContain(
    "secret must never",
  );
  f.failConnect = false;
  await f.token("new-token");
  await f.tick();
  expect(f.tokens).toHaveLength(2);
  f.nextStatus = "failed";
  await f.receive(f.message("failed"));
  await f.tick();
  await f.tick();
  expect(f.submitted).toHaveLength(1);
  expect(f.responseCalls).toHaveLength(0);
  expect(f.sent.map((entry) => entry.text).join("")).toContain(
    "could not complete",
  );
  expect(
    await f.runtime.runPromise(
      GatewayRepository.use((repository) => repository.pending),
    ),
  ).toHaveLength(0);
});

test("routing never falls back for unknown, ambiguous, or disabled recipients and aliases normalize consistently", () => {
  const config = {
    ...defaultGatewayConfig(),
    defaultBotId: ada,
    aliases: [{ handle: "researcher", botId: grace }],
  };

  const bots = [
    { id: ada, name: "Ada", enabled: true },
    { id: grace, name: "Grace", enabled: false },
  ];

  expect(() =>
    selectGatewayBot(config, "@RESEARCHER hello", bots, ada),
  ).toThrow("disabled");
  expect(() => selectGatewayBot(config, "@unknown hello", bots, ada)).toThrow(
    "Unknown",
  );
  expect(() =>
    selectGatewayBot(
      config,
      "@Ada hello",
      [...bots, { ...bots[0]!, id: "third" }],
      null,
    ),
  ).toThrow("ambiguous");
  expect(
    gatewayConfigInput.safeParse({
      ...config,
      aliases: [
        { handle: "Researcher", botId: ada },
        { handle: "Ｒｅｓｅａｒｃｈｅｒ", botId: grace },
      ],
    }).success,
  ).toBe(false);
  expect(gatewayChunks("🙂".repeat(4), 3)).toEqual(["🙂", "🙂", "🙂", "🙂"]);
  expect(selectGatewayBot(config, "@aDA hello", bots, null).id).toBe(ada);
  expect(
    selectGatewayBot(
      config,
      "@Ada Lovelace hello",
      [...bots, { id: "third", name: "Ada Lovelace", enabled: true }],
      null,
    ).id,
  ).toBe("third");
});

test("diagnostic adapter errors do not recreate a healthy connection", async () => {
  const f = await fixture();
  await f.update();
  await f.tick();
  f.host.onStatus("error", "SDK error");
  await f.tick();
  await f.tick();
  expect(f.tokens).toHaveLength(1);
  expect(f.closes).toBe(0);
});

test("failed sends do not retry on every poll", async () => {
  const f = await fixture();
  await f.update();
  f.failSend = true;
  await f.receive(f.message("retry"));
  await f.tick();
  await f.tick();
  await f.tick();
  expect(f.attempts).toHaveLength(1);
});

test("old multiple-sender configuration fails closed", () => {
  expect(
    gatewayConfigInput.safeParse({
      ...defaultGatewayConfig(),
      allowedSenderIds: ["owner", "outsider"],
    }).success,
  ).toBe(false);
});

for (const status of [403, 404])
  test(`HTTP ${status} delivery fails permanently and preserves a visible failure count`, async () => {
    const f = await fixture();
    await f.update();
    f.sendError = new GatewayTransportError("private platform details", {
      permanent: true,
      status,
    });
    await f.receive(f.message(`permanent-${status}`));
    await f.tick();
    await f.tick();
    expect(f.attempts).toHaveLength(1);
    expect((await f.runtime.runPromise(f.gateway.list))[0]).toMatchObject({
      pendingCount: 0,
      failedCount: 1,
    });
    expect(
      (await f.runtime.runPromise(f.gateway.list))[0]?.error,
    ).not.toContain("private platform details");
  });

test("429 adapter cooldown includes new receipts and survives restarting the core", async () => {
  const f = await fixture(undefined, undefined, true);
  await f.update({ ...f.config, allowedChannelIds: ["channel", "other"] });
  f.sendError = new GatewayTransportError("rate limited", {
    permanent: false,
    status: 429,
    retryAfterMs: 90000,
    rateLimit: { scope: "adapter" },
  });
  await f.receive(f.message("limited"));
  await f.tick();
  expect(f.attempts).toHaveLength(1);

  const [receipt] = await f.runtime.runPromise(
    GatewayRepository.use((repository) => repository.pending),
  );

  expect(receipt).toMatchObject({ attemptCount: 1, nextAttemptAt: 90000 });
  await f.receive(f.message("new", { channelId: "other" }));
  expect(
    await f.runtime.runPromise(
      GatewayRepository.use((repository) => repository.pending),
    ),
  ).toHaveLength(2);
  await f.tick();
  expect(f.attempts).toHaveLength(1);
  await f.close();
  const reopened = await fixture(f.folder, undefined, true);
  await reopened.tick();
  await reopened.runtime.runPromise(TestClock.setTime(89999));
  await reopened.tick();
  expect(reopened.attempts).toHaveLength(0);
  await reopened.runtime.runPromise(TestClock.adjust(1));
  await reopened.tick();
  expect(reopened.attempts).toHaveLength(2);
});

test("failed login and brief successful sessions sustain bounded reconnect backoff", async () => {
  const f = await fixture(undefined, undefined, true);
  await f.update();
  f.failConnect = true;
  await f.tick();
  await f.runtime.runPromise(TestClock.adjust(59999));
  await f.tick();
  expect(f.tokens).toHaveLength(1);
  f.failConnect = false;
  await f.runtime.runPromise(TestClock.adjust(1));
  await f.tick();
  expect(f.tokens).toHaveLength(2);
  f.host.onInvalidated();
  await f.tick();
  await f.runtime.runPromise(TestClock.adjust(60000));
  await f.tick();
  expect(f.tokens).toHaveLength(2);
  await f.runtime.runPromise(TestClock.adjust(60000));
  await f.tick();
  expect(f.tokens).toHaveLength(3);
});

test("ten failures and 24 hour expiry stop automatic delivery", async () => {
  const f = await fixture(undefined, undefined, true);
  await f.update();
  f.failSend = true;
  await f.receive(f.message("ten-failures"));

  for (let attempt = 0; attempt < 10; attempt++) {
    await f.tick();

    const [receipt] = await f.runtime.runPromise(
      GatewayRepository.use((repository) => repository.pending),
    );

    if (receipt)
      await f.runtime.runPromise(TestClock.setTime(receipt.nextAttemptAt!));
  }

  await f.tick();
  expect(f.attempts).toHaveLength(10);
  expect((await f.runtime.runPromise(f.gateway.list))[0]?.failedCount).toBe(1);
  await f.receive(f.message("expired"));
  await f.runtime.runPromise(TestClock.adjust(86400000));
  await f.tick();
  expect(f.attempts).toHaveLength(10);
  expect((await f.runtime.runPromise(f.gateway.list))[0]?.failedCount).toBe(2);
});

test("a held send leaves other channels and configuration responsive", async () => {
  const f = await fixture();
  await f.update({ ...f.config, allowedChannelIds: ["channel", "other"] });
  const gate = Promise.withResolvers<void>();
  f.sendGates.set("channel", gate.promise);
  await f.receive(f.message("held"));
  await f.receive(f.message("independent", { channelId: "other" }));
  await f.tick();
  expect(f.attempts).toHaveLength(2);
  expect(f.sent.map((entry) => entry.channelId)).toEqual(["other"]);
  await f.update({ ...f.config, ownerId: "replacement" });
  expect(f.closes).toBe(1);
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.sent).toHaveLength(1);

  const [receipt] = await f.runtime.runPromise(
    GatewayRepository.use((repository) => repository.pending),
  );

  expect(receipt?.attemptCount).toBe(0);
});

test("corrupt and legacy saved configuration stays disabled and can be repaired", async () => {
  const f = await fixture();

  for (const value of [
    { bad: true },
    {
      ...f.config,
      ownerId: undefined,
      allowedSenderIds: ["owner", "outsider"],
    },
  ]) {
    await f.runtime.runPromise(
      SettingsRepository.use((settings) =>
        settings.set(
          `message-gateway:${f.adapter.id}`,
          JSON.parse(JSON.stringify(value)),
        ),
      ),
    );
    await f.tick();
    const [description] = await f.runtime.runPromise(f.gateway.list);
    expect(description?.config).toEqual(defaultGatewayConfig());
    expect(description?.error).toContain("single owner");
    expect(f.tokens).toHaveLength(0);
  }

  await f.update();
  await f.tick();
  expect(f.tokens).toHaveLength(1);
});

test("native mention routing preserves the submitted text and empty mention content never executes", async () => {
  const f = await fixture();
  await f.update();
  await f.receive(
    f.message("native", {
      text: "<@application> @other hello",
      routingText: "@other hello",
    }),
  );
  await f.tick();
  expect(f.submitted).toEqual([
    expect.objectContaining({
      botId: grace,
      text: "<@application> @other hello",
    }),
  ]);
  await f.receive(
    f.message("only-mention", { text: "<@application>", routingText: "" }),
  );
  await f.tick();
  expect(f.submitted).toHaveLength(1);
  expect(f.sent.at(-1)?.text).toContain("Send a text message");
});

test("owner revocation invalidates a receipt paused during scheduling before bot submission", async () => {
  const f = await fixture();
  await f.update();
  await f.tick();
  await f.receive(f.message("race"));
  const repository = await f.runtime.runPromise(GatewayRepository);
  const cooldown = repository.cooldown;
  const gate = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  let intercepted = false;
  Object.assign(repository, {
    cooldown: (adapterId: string, channelId: string) =>
      cooldown(adapterId, channelId).pipe(
        Effect.flatMap((value) => {
          if (intercepted) return Effect.succeed(value);
          intercepted = true;
          blocked.resolve();

          return Effect.promise(() => gate.promise.then(() => value));
        }),
      ),
  });
  const ticking = f.runtime.runPromise(f.gateway.tick);
  await blocked.promise;
  await f.update({ ...f.config, ownerId: null });
  expect(f.submitted).toHaveLength(0);
  gate.resolve();
  await ticking;

  for (let turn = 0; turn < 5; turn++)
    await new Promise((resolve) => setImmediate(resolve));
  Object.assign(repository, { cooldown });
  expect(f.submitted).toHaveLength(0);
});

test("a cooldown learned while a response is loading is checked again before sending", async () => {
  const f = await fixture(undefined, undefined, true);
  await f.update({ ...f.config, allowedChannelIds: ["channel", "other"] });
  const gate = Promise.withResolvers<void>();
  f.responseGate = gate.promise;
  await f.receive(f.message("waiting-response"));
  await f.tick();
  expect(f.responseCalls).toHaveLength(1);
  f.sendError = new GatewayTransportError("rate limited", {
    permanent: false,
    status: 429,
    retryAfterMs: 90000,
    rateLimit: { scope: "adapter" },
  });
  await f.receive(
    f.message("rate-limit", { channelId: "other", hasAttachments: true }),
  );
  await f.tick();
  expect(f.attempts).toHaveLength(1);
  f.sendError = undefined;
  gate.resolve();

  for (let turn = 0; turn < 5; turn++)
    await new Promise((resolve) => setImmediate(resolve));
  expect(f.attempts).toHaveLength(1);
  await f.runtime.runPromise(TestClock.adjust(90000));
  await f.tick();
  expect(f.attempts).toHaveLength(3);
});

test("channel cooldown blocks new messages on that channel while other channels continue", async () => {
  const f = await fixture(undefined, undefined, true);
  await f.update({ ...f.config, allowedChannelIds: ["channel", "other"] });
  f.sendError = new GatewayTransportError("rate limited", {
    permanent: false,
    status: 429,
    retryAfterMs: 90000,
    rateLimit: { scope: "channel" },
  });
  await f.receive(f.message("rate-limit"));
  await f.tick();
  expect(f.attempts).toHaveLength(1);
  f.sendError = undefined;
  await f.receive(f.message("same"));
  await f.receive(f.message("other", { channelId: "other" }));
  await f.tick();
  expect(f.attempts).toHaveLength(2);
  expect(f.sent.map((entry) => entry.channelId)).toEqual(["other"]);
  await f.close();
  const reopened = await fixture(f.folder, undefined, true);
  await reopened.tick();
  expect(reopened.attempts).toHaveLength(0);
  await reopened.runtime.runPromise(TestClock.setTime(90000));
  await reopened.tick();
  await reopened.tick();
  expect(reopened.attempts).toHaveLength(2);
});
