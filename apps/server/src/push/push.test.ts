import { PUSH_TTL_SECONDS } from "../shared/push-devices";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime, Option, Scope } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  desktopIntentGate,
  type GateCall,
} from "../bot-desktop/desktop-intent";
import { HeldActions, heldActionsAccess } from "../bot-desktop/held-actions";
import { heldActionNotices } from "../bot-desktop/held-action-notices";
import { HELD_ACTION_ENTRY } from "../transcript/entries";
import { TestClock } from "effect/testing";
import { Push, PushDelivery } from "./push";
import {
  canonicalReplyEvent,
  type ReplyActivity,
  type ReplyEvent,
} from "../contract/reply-event";
import { notificationTitle, type PushDeviceInput } from "./push-model";
import { PushRepository } from "./push-repository";
import {
  PermanentRejection,
  PushTransports,
  TemporaryFailure,
  type PushTransport,
} from "./push-transports";
import { BotActivity } from "../bots/bot-activity";
import type { Activity } from "../bots/bots";
import { Store } from "../../test/support/store";
import { standaloneBots } from "../bots/bots-test-support";
import { standaloneScheduler } from "../automations/scheduler-test-support";
import { testAPI } from "../../test/support/api";
import type { Agent } from "../contract/agents";
import { until } from "../../test/support/until";
import { coreLayer } from "../app/core-layer";
import { ChatAttention } from "./chat-attention";
import { layerOfRunner } from "../shared/runner";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime } from "../bots/runtime";
import { runtimeCallbacks } from "../../test/support/runtime-callbacks";
import {
  credentialExtension,
  credentialsAccess,
} from "../credentials/credentials";
import { loginExtension, loginsAccess } from "../logins/logins";
import { parseEntryId } from "../shared/entry-ids";
import { standaloneGroupChats } from "../group-chats/group-chats-test-support";
import { GroupTranscripts } from "../group-chats/group-transcripts";

type TestRequestInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const id = () => crypto.randomUUID();

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join("/tmp", prefix));
  dirs.push(dir);

  return dir;
};

const createBot = (store: Store, agentId: string) =>
  store.createAgent(
    {
      name: "Bot",
      description: "",
      instructions: "help",
      provider: "openai",
      model: "gpt-4.1",
      enabled: true,
      tools: [],
      skills: [],
      mcpServers: [],
      delegates: [],
    },
    agentId,
  );

const android = (token: string): PushDeviceInput => ({
  platform: "android",
  transport: "fcm",
  token,
  environment: "production",
  enabled: true,
});

const fcmOnly = (fcm: Omit<PushTransport, "canSend">) =>
  Layer.succeed(PushTransports, {
    apns: undefined,
    fcm: { canSend: () => true, ...fcm },
  });

async function pushRuntime(
  dir: string,
  transports: Layer.Layer<PushTransports, never, PushRepository>,
  startAt = 0,
) {
  const runtime = ManagedRuntime.make(
    Push.layerNoDeps.pipe(
      Layer.provide(transports),
      Layer.provideMerge(PushRepository.layerNoDeps),
      Layer.provideMerge(coreLayer(dir)),
      Layer.provideMerge(TestClock.layer()),
    ),
  );

  await runtime.runPromise(TestClock.setTime(startAt));

  return runtime;
}

const reply = (agentId: string, at: number): ReplyActivity => ({
  type: "reply",
  executionId: id(),
  agentId,
  agentName: "Bot",
  entryId: null,
  origin: "owner",
  preview: "hi",
  createdAt: new Date(at).toISOString(),
});

describe("push registration and durable delivery", () => {
  test("canonical event preserves SSE/APNs/FCM fields", () => {
    const event = canonicalReplyEvent(
      {
        executionId: "e",
        agentId: "a",
        agentName: "Bot",
        entryId: null,
        origin: "owner",
        preview: "hello",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "s",
    );

    expect(event).toEqual({
      type: "reply",
      eventId: "e",
      serverId: "s",
      agentId: "a",
      agentName: "Bot",
      entryId: null,
      origin: "owner",
      preview: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("exercises authenticated registration and presence API validation", async () => {
    const dir = tempDir("crumble-push-api-");
    const token = "t".repeat(40);
    const store = new Store(dir);

    const runtime: any = {
      openChat: async () => "chat",
      history: async () => ({ messages: [] }),
      snapshot: async () => ({
        messages: [],
        status: "idle",
        live: null,
        updatedAt: 0,
      }),
      prepareInput: async (_agent: Agent, text: string) => ({
        modelContent: text,
        data: { text },
      }),
      submit: async () => "submission",
      wait: async () => ({ status: "done" }),
      abort: async () => {},
      deleteAgent: async () => {},
    };

    const service = standaloneBots(store, runtime);
    const scheduler = standaloneScheduler(store.runtime, async () => {});

    const push = ManagedRuntime.make(
      Push.layerNoDeps.pipe(
        Layer.provide(fcmOnly({ send: () => Effect.succeed("delivered") })),
        Layer.provideMerge(PushRepository.layerNoDeps),
        Layer.provideMerge(layerOfRunner(store.runtime)),
      ),
    );

    const app = testAPI(service, token, { scheduler, push });
    const installationId = id();

    const request = (path: string, init: TestRequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });

    expect((await app.request("/v1/push")).status).toBe(401);
    const info = await request("/v1/push");
    expect(info.status).toBe(200);
    // SAFETY: The endpoint response is the PushInfo object under test.
    expect(((await info.json()) as any).serverId).toBe(
      await push.runPromise(Push.use((p) => Effect.succeed(p.serverId))),
    );
    expect(
      (
        await request(`/v1/push/devices/${installationId}`, {
          method: "PUT",
          body: JSON.stringify({ ...android("x"), platform: "macos" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/v1/push/devices/${installationId}`, {
          method: "PUT",
          body: JSON.stringify(android("x")),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/v1/chat-attention/views/${id()}`, {
          method: "PUT",
          body: JSON.stringify({ chat: null }),
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(`/v1/chat-attention/views/${id()}`, {
          method: "PUT",
          body: JSON.stringify({ chat: { kind: "bot", id: id() } }),
        })
      ).status,
    ).toBe(404);
    await push.dispose();
    await scheduler.stop();
    store.close();
  });

  test("persists server ID and keeps presence across token rotation", async () => {
    const dir = tempDir("crumble-push-");
    const installationId = id();
    const agentId = id();

    const ios = (token: string): PushDeviceInput => ({
      platform: "macos",
      transport: "apns",
      token,
      environment: "development",
      bundleId: "com.example",
      enabled: true,
    });

    const first = await pushRuntime(
      dir,
      Layer.succeed(PushTransports, { apns: undefined, fcm: undefined }),
      1_000_000,
    );

    createBot(new Store(first), agentId);
    const serverId = await first.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        const serverId = yield* store.serverId;
        yield* store.upsertDevice(installationId, ios("old"));
        yield* (yield* ChatAttention).view(installationId, {
          kind: "bot",
          id: agentId,
        });
        yield* store.upsertDevice(installationId, ios("new"));
        expect(
          Option.getOrThrow(yield* store.getDevice(installationId)).token,
        ).toBe("new");
        expect(
          yield* (yield* ChatAttention).isSuppressed(
            { kind: "bot", id: agentId },
            id(),
          ),
        ).toBe(true);

        return serverId;
      }),
    );

    await first.dispose();

    const second = await pushRuntime(
      dir,
      Layer.succeed(PushTransports, { apns: undefined, fcm: undefined }),
      1_000_000,
    );

    await second.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        expect(yield* store.serverId).toBe(serverId);
        expect(
          Option.getOrThrow(yield* store.getDevice(installationId)).token,
        ).toBe("new");
      }),
    );
    await second.dispose();
  });

  test("delivers a group answer even while its bot's chat is visible", async () => {
    const dir = tempDir("crumble-push-");
    const now = 1_000_000;
    const installationId = id();
    const agentId = id();
    const sent: ReplyEvent[] = [];

    const push = await pushRuntime(
      dir,
      fcmOnly({
        send: (_device, event) =>
          Effect.sync(() => {
            sent.push(event);

            return "delivered" as const;
          }),
      }),
      now,
    );

    const groupStore = new Store(push);
    createBot(groupStore, agentId);
    groupStore.createGroupChat(
      { name: "Trip", memberIds: [agentId] },
      "group-1",
    );
    const answer = reply(agentId, now);

    const serverId = await push.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        yield* store.upsertDevice(installationId, android("token"));
        yield* (yield* ChatAttention).view(installationId, {
          kind: "bot",
          id: agentId,
        });

        const service = yield* Push;

        yield* service.enqueue({
          ...answer,
          agentName: "Ada",
          entryId: "group-1:4",
          origin: "group",
          preview: "Booked.",
          groupId: "group-1",
          groupName: "Trip",
        });
        yield* TestClock.adjust(3000);
        yield* service.drain;

        return service.serverId;
      }),
    );

    expect(sent).toEqual([
      {
        type: "reply",
        eventId: answer.executionId,
        serverId,
        agentId,
        agentName: "Ada",
        entryId: "group-1:4",
        origin: "group",
        preview: "Booked.",
        createdAt: "1970-01-01T00:16:40.000Z",
        groupId: "group-1",
        groupName: "Trip",
      },
    ]);
    expect(notificationTitle(sent[0]!)).toBe("Ada in Trip");
    await push.dispose();
  });

  test("suppresses visible-agent replies and sends once across concurrent drains", async () => {
    const dir = tempDir("crumble-push-");
    const now = 1_000_000;
    const installationId = id();
    const agentId = id();
    const sent: string[] = [];
    const hidden = reply(agentId, now);
    const shown = reply(agentId, now);

    const push = await pushRuntime(
      dir,
      fcmOnly({
        send: (_device, event) =>
          Effect.sync(() => {
            sent.push(event.eventId);

            return "delivered" as const;
          }),
      }),
      now,
    );

    createBot(new Store(push), agentId);
    await push.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        const service = yield* Push;
        yield* store.upsertDevice(installationId, android("token"));
        yield* (yield* ChatAttention).view(installationId, {
          kind: "bot",
          id: agentId,
        });

        yield* service.enqueue(hidden);
        yield* TestClock.adjust(3000);
        yield* service.drain;
        expect(sent).toEqual([]);

        yield* (yield* ChatAttention).view(installationId, null);
        yield* store.upsertDevice(id(), android("token-2"));
        yield* store.enqueue(canonicalReplyEvent(shown, service.serverId));
        yield* TestClock.adjust(3000);
      }),
    );

    const drain = Push.use((service) => service.drain);
    await Promise.all([push.runPromise(drain), push.runPromise(drain)]);
    expect(sent).toEqual([shown.executionId, shown.executionId]);
    await push.dispose();
  });

  test("expires before send and does not disable a rotated token", async () => {
    const dir = tempDir("crumble-push-");
    const now = 5_000;
    const installationId = id();
    const agentId = id();

    const rejecting = await pushRuntime(
      dir,
      fcmOnly({
        send: () => Effect.fail(new PermanentRejection({ message: "invalid" })),
      }),
      now,
    );

    createBot(new Store(rejecting), agentId);
    await rejecting.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        const service = yield* Push;
        yield* store.upsertDevice(installationId, {
          ...android("old"),
        });
        yield* store.enqueue(
          canonicalReplyEvent(reply(agentId, now), service.serverId),
        );
        yield* TestClock.adjust(PUSH_TTL_SECONDS * 1000 + 100);
        yield* service.drain;
        expect(
          Option.getOrThrow(yield* store.getDevice(installationId)).enabled,
        ).toBe(true);
      }),
    );
    await rejecting.dispose();

    let rotationAttempts = 0;
    let deliveredToken = "";

    const rotatingTransports = Layer.effect(
      PushTransports,
      Effect.gen(function* () {
        const store = yield* PushRepository;

        return {
          apns: undefined,
          fcm: {
            canSend: () => true,
            send: (device) =>
              Effect.gen(function* () {
                rotationAttempts++;
                yield* store.upsertDevice(installationId, android("new"));

                if (rotationAttempts === 1)
                  return yield* new PermanentRejection({ message: "invalid" });
                deliveredToken = device.token;

                return "delivered" as const;
              }),
          },
        };
      }),
    );

    const rotating = await pushRuntime(
      dir,
      rotatingTransports,
      now + PUSH_TTL_SECONDS * 1000 + 200,
    );

    await rotating.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        const service = yield* Push;
        yield* store.enqueue(
          canonicalReplyEvent(reply(agentId, now + 200), service.serverId),
        );
        yield* TestClock.adjust(3000);
        yield* service.drain;
        yield* service.drain;

        const device = Option.getOrThrow(
          yield* store.getDevice(installationId),
        );

        expect(device.token).toBe("new");
        expect(device.enabled).toBe(true);
      }),
    );
    expect(deliveredToken).toBe("new");
    await rotating.dispose();
  });

  test("retries a transient delivery after backoff and bounds attempts", async () => {
    const dir = tempDir("crumble-push-");
    const now = 10_000;
    const installationId = id();
    let attempts = 0;

    const push = await pushRuntime(
      dir,
      fcmOnly({
        send: () =>
          ++attempts === 1
            ? Effect.fail(new TemporaryFailure({ message: "temporary" }))
            : Effect.succeed("delivered"),
      }),
      now,
    );

    const agentId = id();
    createBot(new Store(push), agentId);
    await push.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        const service = yield* Push;
        yield* store.upsertDevice(installationId, android("token"));
        yield* store.enqueue(
          canonicalReplyEvent(reply(agentId, now), service.serverId),
        );
        yield* TestClock.adjust(3000);
        yield* service.drain;
        expect(attempts).toBe(1);
        yield* TestClock.adjust(500);
        yield* service.drain;
        expect(attempts).toBe(1);
        yield* TestClock.adjust(600);
        yield* service.drain;
        expect(attempts).toBe(2);
      }),
    );
    await push.dispose();
  });

  test("delivers a completed reply through service activity without an SSE subscriber", async () => {
    const dir = tempDir("crumble-push-service-");
    const store = new Store(dir);

    const agent = store.createAgent({
      name: "Bot",
      description: "",
      instructions: "help",
      provider: "openai",
      model: "gpt-4.1",
      enabled: true,
      tools: [],
      skills: [],
      mcpServers: [],
      delegates: [],
    });

    const runtime: any = {
      openChat: async () => "runtime-chat",
      prepareInput: async (_agent: Agent, text: string) => ({
        modelContent: text,
        data: { text },
      }),
      submit: async () => "submission",
      wait: async () => ({ status: "done" }),
      snapshot: async () => ({
        messages: [
          {
            id: "entry-1:0",
            role: "assistant",
            content: "hello from bot",
            entryId: "entry-1",
          },
        ],
        status: "idle",
        live: null,
        updatedAt: Date.now(),
      }),
      history: async () => ({ messages: [] }),
      abort: async () => {},
      deleteAgent: async () => {},
      close: async () => {},
    };

    const service = standaloneBots(store, runtime);
    const installationId = id();
    let delivered: ReplyEvent | undefined;

    const push = ManagedRuntime.make(
      PushDelivery.pipe(
        Layer.provideMerge(
          Push.layerNoDeps.pipe(
            Layer.provide(
              fcmOnly({
                send: (_device, event) =>
                  Effect.sync(() => {
                    delivered = event;

                    return "delivered" as const;
                  }),
              }),
            ),
            Layer.provideMerge(PushRepository.layerNoDeps),
            Layer.provideMerge(layerOfRunner(store.runtime)),
          ),
        ),
        Layer.provide(
          Layer.succeed(BotActivity, {
            subscribe: (listener: (event: Activity) => void) =>
              service.onActivity(listener),
          }),
        ),
      ),
    );

    await push.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        yield* store.upsertDevice(installationId, android("token"));
      }),
    );

    const chat = await service.chat(agent.id);
    const execution = await service.send(chat.id, "question", id());
    await until(async () => {
      await push.runPromise(Push.use((p) => p.drain));

      return delivered !== undefined;
    });
    expect(delivered).toMatchObject({
      eventId: execution.id,
      agentId: agent.id,
      entryId: "entry-1",
      preview: "hello from bot",
    });
    await push.dispose();
    await service.close();
  });
});

test("respects grace retry and deletion boundaries", async () => {
  const dir = tempDir("crumble-push-boundaries-");
  const sent: string[] = [];
  let fail = false;
  const runtime = ManagedRuntime.make(
    Push.layerNoDeps.pipe(
      Layer.provide(
        fcmOnly({
          send: (_device, event) => {
            sent.push(event.eventId);
            return fail
              ? Effect.fail(new TemporaryFailure({ message: "temporary" }))
              : Effect.succeed("delivered");
          },
        }),
      ),
      Layer.provideMerge(PushRepository.layerNoDeps),
      Layer.provideMerge(coreLayer(dir)),
      Layer.provideMerge(TestClock.layer()),
    ),
  );
  await runtime.runPromise(Effect.void);
  const store = new Store(runtime);
  const agent = store.createAgent({
    name: "Bot",
    description: "",
    instructions: "help",
    provider: "openai",
    model: "gpt-4.1",
    enabled: true,
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
  });
  const chat = { kind: "bot" as const, id: agent.id };
  const first = reply(agent.id, 0);
  const retry = reply(agent.id, 0);
  const deleted = reply(agent.id, 0);
  const afterRestart = reply(agent.id, 0);
  const late = reply(agent.id, 0);
  await runtime.runPromise(
    Effect.gen(function* () {
      const push = yield* Push;
      const repository = yield* PushRepository;
      const attention = yield* ChatAttention;
      yield* repository.upsertDevice(id(), android("token"));
      yield* push.enqueue(first);
      yield* TestClock.adjust(2999);
      yield* push.enqueue(first);
      yield* push.drain;
      expect(sent).toEqual([]);
      yield* TestClock.adjust(1);
      yield* push.drain;
      expect(sent).toEqual([first.executionId]);
      yield* attention.register({
        eventId: retry.executionId,
        chat,
        messageId: "message",
        entryId: "entry",
        surface: { kind: "text" },
      });
      fail = true;
      yield* push.enqueue(retry);
      yield* TestClock.adjust(3000);
      yield* push.drain;
      expect(sent).toEqual([first.executionId, retry.executionId]);
      yield* attention.seen(chat, [retry.executionId]);
      yield* TestClock.adjust(1000);
      yield* push.drain;
      expect(sent).toEqual([first.executionId, retry.executionId]);
      fail = false;
      yield* push.enqueue(afterRestart);
      yield* TestClock.adjust(1000);
    }),
  );
  await runtime.dispose();
  expect(sent).toEqual([first.executionId, retry.executionId]);

  const enqueueEntered = Promise.withResolvers<void>();
  const finishEnqueue = Promise.withResolvers<void>();
  const delayedEnqueueRepository = Layer.effect(
    PushRepository,
    Effect.gen(function* () {
      const repository = yield* PushRepository;

      return PushRepository.of({
        ...repository,
        enqueue: Effect.fnUntraced(function* (event: ReplyEvent) {
          if (event.eventId === late.executionId) {
            enqueueEntered.resolve();
            yield* Effect.promise(() => finishEnqueue.promise);
          }
          yield* repository.enqueue(event);
        }),
      });
    }),
  ).pipe(Layer.provide(PushRepository.layerNoDeps));

  const restarted = ManagedRuntime.make(
    Push.layerNoDeps.pipe(
      Layer.provide(
        fcmOnly({
          send: (_device, event) =>
            Effect.sync(() => {
              sent.push(event.eventId);
              return "delivered" as const;
            }),
        }),
      ),
      Layer.provideMerge(delayedEnqueueRepository),
      Layer.provideMerge(coreLayer(dir)),
      Layer.provideMerge(TestClock.layer()),
    ),
  );
  await restarted.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(9999);
      yield* Push.use((push) => push.drain);
      expect(sent).toEqual([first.executionId, retry.executionId]);
      yield* TestClock.adjust(1);
      yield* Push.use((push) => push.drain);
      expect(sent).toEqual([
        first.executionId,
        retry.executionId,
        afterRestart.executionId,
      ]);
      yield* Push.use((push) => push.enqueue(deleted));
    }),
  );
  const restartedStore = new Store(restarted);
  const delayedEnqueue = restarted.runPromise(
    Push.use((push) => push.enqueue(late)),
  );
  await enqueueEntered.promise;
  restartedStore.deleteAgent(agent.id);
  finishEnqueue.resolve();
  await delayedEnqueue;
  await restarted.runPromise(
    Effect.gen(function* () {
      yield* Push.use((push) => push.enqueue(reply(agent.id, 0)));
      yield* TestClock.adjust(3000);
      yield* Push.use((push) => push.drain);
      expect(
        yield* (yield* ChatAttention)
          .register({
            eventId: late.executionId,
            chat,
            messageId: "late",
            entryId: "late",
            surface: { kind: "text" },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "NotFound" });
    }),
  );
  expect(sent).toEqual([
    first.executionId,
    retry.executionId,
    afterRestart.executionId,
  ]);
  await restarted.dispose();
});

test("suppresses matching chats across views and destination devices", async () => {
  const dir = tempDir("crumble-attention-views-");
  const sent: { token: string; eventId: string }[] = [];
  const runtime = ManagedRuntime.make(
    Push.layerNoDeps.pipe(
      Layer.provide(
        fcmOnly({
          send: (device, event) =>
            Effect.sync(() => {
              sent.push({ token: device.token, eventId: event.eventId });
              return "delivered" as const;
            }),
        }),
      ),
      Layer.provideMerge(PushRepository.layerNoDeps),
      Layer.provideMerge(coreLayer(dir)),
      Layer.provideMerge(TestClock.layer()),
    ),
  );
  await runtime.runPromise(Effect.void);
  const store = new Store(runtime);
  const agent = store.createAgent({
    name: "Bot",
    description: "",
    instructions: "help",
    provider: "openai",
    model: "gpt-4.1",
    enabled: true,
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
  });
  const group = store.createGroupChat({ name: "Group", memberIds: [agent.id] });
  const botChat = { kind: "bot" as const, id: agent.id };
  const groupChat = { kind: "group" as const, id: group.id };
  const botHidden = reply(agent.id, 0);
  const waiting = { ...reply(agent.id, 0), waitingFor: "approval" as const };
  const groupHidden = {
    ...reply(agent.id, 0),
    origin: "group",
    groupId: group.id,
  };
  const groupVisible = {
    ...reply(agent.id, 0),
    origin: "group",
    groupId: group.id,
  };
  const botVisible = reply(agent.id, 0);
  const afterClear = reply(agent.id, 0);
  const afterTtl = reply(agent.id, 0);
  await runtime.runPromise(
    Effect.gen(function* () {
      const push = yield* Push;
      const attention = yield* ChatAttention;
      yield* attention.view("web", botChat);
      yield* attention.view("native", botChat);
      yield* push.device(id(), android("one"));
      yield* push.device(id(), android("two"));
      yield* push.enqueue(botHidden);
      yield* push.enqueue(waiting);
      yield* push.enqueue(groupVisible);
      yield* TestClock.adjust(3000);
      yield* push.drain;
      expect(sent.map((s) => s.eventId)).toEqual([
        groupVisible.executionId,
        groupVisible.executionId,
      ]);
      yield* attention.view("group", groupChat);
      yield* attention.view("web", null);
      yield* push.enqueue(groupHidden);
      yield* push.enqueue(reply(agent.id, 3000));
      yield* TestClock.adjust(3000);
      yield* push.drain;
      expect(sent).toHaveLength(2);
      yield* attention.view("native", null);
      yield* push.enqueue(botVisible);
      yield* TestClock.adjust(3000);
      yield* push.drain;
      expect(
        sent
          .filter((s) => s.eventId === botVisible.executionId)
          .map((s) => s.token)
          .sort(),
      ).toEqual(["one", "two"]);
      yield* attention.view("group", null);
      yield* push.enqueue({
        ...afterClear,
        origin: "group",
        groupId: group.id,
      });
      yield* TestClock.adjust(3000);
      yield* push.drain;
      expect(
        sent.filter((s) => s.eventId === afterClear.executionId),
      ).toHaveLength(2);
      yield* attention.view("expiring", botChat);
      yield* TestClock.adjust(120001);
      yield* push.enqueue(afterTtl);
      yield* TestClock.adjust(3000);
      yield* push.drain;
      expect(
        sent.filter((s) => s.eventId === afterTtl.executionId),
      ).toHaveLength(2);
    }),
  );
  await runtime.dispose();
});

test("keeps chat attention ownership atomic and account-scoped", async () => {
  const makeAccount = async (token: string) => {
    const sent: string[] = [];
    const runtime = ManagedRuntime.make(
      Push.layerNoDeps.pipe(
        Layer.provide(
          fcmOnly({
            send: (_device, event) =>
              Effect.sync(() => {
                sent.push(event.eventId);
                return "delivered" as const;
              }),
          }),
        ),
        Layer.provideMerge(PushRepository.layerNoDeps),
        Layer.provideMerge(coreLayer(tempDir("crumble-attention-account-"))),
        Layer.provideMerge(TestClock.layer()),
      ),
    );
    await runtime.runPromise(Effect.void);
    const store = new Store(runtime);
    const agent = store.createAgent({
      name: "Bot",
      description: "",
      instructions: "help",
      provider: "openai",
      model: "gpt-4.1",
      enabled: true,
      tools: [],
      skills: [],
      mcpServers: [],
      delegates: [],
    });
    const bots = standaloneBots(store, { close: async () => {} } as Parameters<
      typeof standaloneBots
    >[1]);
    const scheduler = standaloneScheduler(store.runtime, async () => {});
    const app = testAPI(bots, token, { scheduler, push: runtime });
    const request = (path: string, method: string, body: object) =>
      app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    return { runtime, store, agent, bots, scheduler, sent, request };
  };
  const a = await makeAccount("a".repeat(40));
  const b = await makeAccount("b".repeat(40));
  const chatA = { kind: "bot" as const, id: a.agent.id };
  const chatB = { kind: "bot" as const, id: b.agent.id };
  const valid = reply(a.agent.id, 0);
  const foreign = reply(b.agent.id, 0);
  const seen = reply(a.agent.id, 0);
  const association = (eventId: string, chat: typeof chatA) => ({
    eventId,
    chat,
    messageId: eventId,
    entryId: eventId,
    surface: { kind: "text" as const },
  });
  await a.runtime.runPromise(
    Effect.gen(function* () {
      const attention = yield* ChatAttention;
      yield* attention.register(association(valid.executionId, chatA));
      yield* attention.register(association(seen.executionId, chatA));
      yield* Push.use((push) => push.device(id(), android("a")));
    }),
  );
  await b.runtime.runPromise(
    Effect.gen(function* () {
      yield* ChatAttention.use((attention) =>
        attention.register(association(foreign.executionId, chatB)),
      );
      yield* Push.use((push) => push.device(id(), android("b")));
    }),
  );
  expect(
    (
      await a.request("/v1/chat-attention/views/foreign", "PUT", {
        chat: chatB,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await a.request("/v1/chat-attention/seen", "POST", {
        chat: chatB,
        eventIds: [foreign.executionId],
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await a.request("/v1/chat-attention/seen", "POST", {
        chat: chatA,
        eventIds: [valid.executionId, foreign.executionId],
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await a.request("/v1/chat-attention/seen", "POST", {
        chat: chatA,
        eventIds: [seen.executionId],
      })
    ).status,
  ).toBe(204);
  const other = a.store.createAgent({
    name: "Other",
    description: "",
    instructions: "help",
    provider: "openai",
    model: "gpt-4.1",
    enabled: true,
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
  });
  const otherChat = { kind: "bot" as const, id: other.id };
  await a.runtime.runPromise(
    Effect.gen(function* () {
      const attention = yield* ChatAttention;
      const result = yield* Effect.flip(
        attention.register(association(seen.executionId, otherChat)),
      );
      expect(result._tag).toBe("Conflict");
      yield* attention.register(association(seen.executionId, chatA));
      expect(
        (yield* attention.references(chatA, [seen.executionId])).get(
          seen.executionId,
        ),
      ).toHaveLength(1);
      expect(
        (yield* attention.references(otherChat, [seen.executionId])).size,
      ).toBe(0);
      const push = yield* Push;
      yield* push.enqueue(valid);
      yield* push.enqueue(seen);
      yield* TestClock.adjust(3000);
      yield* push.drain;
    }),
  );
  expect(a.sent).toEqual([valid.executionId]);
  await b.runtime.runPromise(
    Effect.gen(function* () {
      const push = yield* Push;
      yield* push.enqueue(foreign);
      yield* TestClock.adjust(3000);
      yield* push.drain;
    }),
  );
  expect(b.sent).toEqual([foreign.executionId]);
  await a.scheduler.stop();
  await b.scheduler.stop();
  await a.bots.close();
  await b.bots.close();
  await a.runtime.dispose();
  await b.runtime.dispose();
});

async function heldSurfaceReply(
  service: ReturnType<typeof standaloneBots<Store>>,
  agent: Agent,
  activities: ReplyActivity[],
): Promise<ReplyActivity> {
  const harness = await service.runtime.documents(agent);
  const root = await harness.root(BACKGROUND_CONTEXT);
  const held = heldActionsAccess(service.store.runtime);
  const scope = Scope.makeUnsafe();

  await service.effects.runPromise(
    Layer.buildWithScope(heldActionNotices, scope).pipe(
      Effect.provideService(
        HeldActions,
        service.store.runtime.runSync(HeldActions.use(Effect.succeed)),
      ),
    ),
  );

  try {
    const entered = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const before = activities.length;
    const call: GateCall = {
      models: createModels(),
      request: async () => ({
        ownerMessages: [],
        tasks: ["Check tickets"],
        job: { name: "tickets", chatId: root.id },
      }),
      postCard: async (chatId, card) => {
        entered.resolve();
        await commit.promise;
        const entry = await harness.commit(
          (tx) =>
            tx.appendEntry(chatId, {
              kind: HELD_ACTION_ENTRY,
              data: { ...card, timestamp: 0 },
            }),
          BACKGROUND_CONTEXT,
        );
        const entryId = `${agent.id}:${Number(entry.id)}`;

        return { entryId, messageId: `${entryId}:0` };
      },
    };
    const intent = { judgeFor: async () => undefined, held };
    const action = {
      action: {
        steps: [
          {
            action: "click" as const,
            target: { role: "button", name: "Buy ticket" },
          },
        ],
        host: "rail.example",
      },
      page: "https://rail.example",
    };
    const waiting = desktopIntentGate(
      intent,
      agent.id,
      call,
    )(action, BACKGROUND_CONTEXT);
    await entered.promise;
    await service.effects.runPromise(Effect.yieldNow);
    expect(activities).toHaveLength(before);
    const pending = held
      .list(agent.id)
      .find((item) => item.status === "pending")!;
    commit.resolve();
    await until(() =>
      activities.some((item) => item.executionId === pending.id),
    );
    const published = activities.find(
      (item) => item.executionId === pending.id,
    )!;
    const message = (
      await service.history(agent.id, { limit: 200 })
    ).messages.find((item) => item.heldAction?.id === pending.id)!;
    expect(published.entryId).toBeNull();
    expect(message.replyReferences).toEqual([
      {
        eventId: pending.id,
        surface: { kind: "held-action", actionId: pending.id },
      },
    ]);
    expect(message.id).toBe(`${message.entryId}:0`);
    await held.decide(agent.id, pending.id, { status: "approved" });
    await waiting;

    const failed = desktopIntentGate(intent, agent.id, {
      ...call,
      postCard: async () => {
        throw new Error("card commit failed");
      },
    });
    await expect(failed(action, BACKGROUND_CONTEXT)).rejects.toThrow(
      "card commit failed",
    );
    await service.effects.runPromise(Effect.yieldNow);
    expect(activities).toHaveLength(before + 1);
    const failedHolds = held
      .list(agent.id)
      .filter((item) => item.id !== pending.id);
    expect(failedHolds).toHaveLength(1);
    expect(failedHolds[0]!.status).toBe("expired");

    return published;
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

test("acknowledges exact reply surfaces before enqueue and after restart", async () => {
  const dir = tempDir("crumble-push-surfaces-");
  const sent: string[] = [];
  const openPush = () =>
    ManagedRuntime.make(
      Push.layerNoDeps.pipe(
        Layer.provide(
          fcmOnly({
            send: (_device, event) =>
              Effect.sync(() => {
                sent.push(event.eventId);
                return "delivered" as const;
              }),
          }),
        ),
        Layer.provideMerge(PushRepository.layerNoDeps),
        Layer.provideMerge(coreLayer(dir)),
        Layer.provideMerge(TestClock.layer()),
      ),
    );
  const push = openPush();
  await push.runPromise(Effect.void);
  const store = new Store(push);
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "chat", input: ["text"] }],
  });
  const answer = "bounded answer ".repeat(100);
  const requests = [
    { tool: "request_credential", name: "ACME_TOKEN", waiting: "credential" },
    { tool: "request_login", name: "acme-login", waiting: "login" },
  ] as const;
  faux.setResponses([
    fauxAssistantMessage(answer),
    ...requests.flatMap(({ tool, name }) => [
      fauxAssistantMessage(
        fauxToolCall(tool, { name, hosts: ["acme.com"], reason: "Needed" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(`Please provide ${name}.`),
    ]),
    fauxAssistantMessage("another answer"),
    fauxAssistantMessage("A group answer."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = standaloneBots(
    store,
    new AgentRuntime(
      dir,
      runtimeCallbacks({
        models,
        extensions: (owner) => [
          credentialExtension(owner.id, credentialsAccess(store.runtime)),
          loginExtension(owner.id, loginsAccess(store.runtime)),
        ],
      }),
    ),
  );
  const agent = store.createAgent({
    name: "Bot",
    description: "",
    instructions: "Answer",
    provider: "faux",
    model: "chat",
    enabled: true,
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
  });
  const chat = { kind: "bot" as const, id: agent.id };
  const activities: ReplyActivity[] = [];
  service.onActivity((activity) => {
    if (activity.type === "reply") activities.push(activity);
  });
  await push.runPromise(
    PushRepository.use((repo) => repo.upsertDevice(id(), android("token"))),
  );
  const first = await service.sendChat(agent.id, "question", id());
  await until(() =>
    activities.some((activity) => activity.executionId === first.id),
  );
  const firstActivity = activities.find(
    (activity) => activity.executionId === first.id,
  )!;
  const history = await service.history(agent.id, { limit: 200 });
  const answerMessage = history.messages.find(
    (message) => message.content === answer,
  )!;
  expect(answerMessage.replyReferences).toEqual([
    { eventId: first.id, surface: { kind: "text" } },
  ]);
  expect(firstActivity.entryId).toBe(answerMessage.entryId);
  expect(firstActivity.preview.length).toBeLessThan(answer.length);
  expect(answer.startsWith(firstActivity.preview)).toBe(true);
  expect(
    (await service.chatSnapshot(agent.id)).messages.find(
      (message) => message.id === answerMessage.id,
    )?.replyReferences,
  ).toEqual(answerMessage.replyReferences);
  await push.runPromise(
    ChatAttention.use((attention) => attention.seen(chat, [first.id])),
  );
  await push.runPromise(Push.use((p) => p.enqueue(firstActivity)));
  const suppressed: ReplyActivity[] = [firstActivity];
  for (const request of requests) {
    const execution = await service.sendChat(
      agent.id,
      `Request ${request.name}`,
      id(),
    );
    await until(() =>
      activities.some((activity) => activity.executionId === execution.id),
    );
    const activity = activities.find(
      (item) => item.executionId === execution.id,
    )!;
    expect(activity.waitingFor).toBe(request.waiting);
    const messages = (await service.history(agent.id, { limit: 200 })).messages;
    const card = messages.findLast(
      (message) => message.toolName === request.tool,
    )!;
    const text = messages.findLast(
      (message) => message.content === `Please provide ${request.name}.`,
    )!;
    expect(card.toolCallId).toBeTruthy();
    if (!card.toolCallId) throw new Error("Request card has no tool call ID");
    expect(card.replyReferences).toEqual([
      {
        eventId: execution.id,
        surface: { kind: "tool-card", toolCallId: card.toolCallId },
      },
    ]);
    expect(text.replyReferences).toEqual([]);
    await push.runPromise(
      ChatAttention.use((attention) => attention.seen(chat, [execution.id])),
    );
    await push.runPromise(Push.use((p) => p.enqueue(activity)));
    suppressed.push(activity);
  }
  const jobId = `desktop-report:${id()}`;
  await service.announceJobAnswer({
    agentId: agent.id,
    kind: "desktop",
    name: "report",
    entryId: String(parseEntryId(answerMessage.entryId)),
    preview: "bounded answer",
    eventId: jobId,
  });
  const jobActivity = activities.find((item) => item.executionId === jobId)!;
  expect(jobActivity).toBeDefined();
  const jobHistory = (await service.history(agent.id, { limit: 200 })).messages;
  expect(
    jobHistory.find((message) => message.id === `${answerMessage.entryId}:0`)
      ?.replyReferences,
  ).toContainEqual({ eventId: jobId, surface: { kind: "text" } });
  expect(
    jobHistory
      .filter((message) => message.id !== `${answerMessage.entryId}:0`)
      .flatMap((message) => message.replyReferences)
      .some((reference) => reference.eventId === jobId),
  ).toBe(false);
  await push.runPromise(
    ChatAttention.use((attention) => attention.seen(chat, [jobId])),
  );
  await push.runPromise(Push.use((p) => p.enqueue(jobActivity)));
  suppressed.push(jobActivity);
  const second = await service.sendChat(agent.id, "another question", id());
  await until(() =>
    activities.some((activity) => activity.executionId === second.id),
  );
  const secondActivity = activities.find(
    (activity) => activity.executionId === second.id,
  )!;
  const secondMessage = (
    await service.history(agent.id, { limit: 200 })
  ).messages.find((message) => message.content === "another answer")!;
  expect(secondMessage.replyReferences).toEqual([
    { eventId: second.id, surface: { kind: "text" } },
  ]);
  const held = await heldSurfaceReply(service, agent, activities);
  await push.runPromise(
    ChatAttention.use((attention) => attention.seen(chat, [held.executionId])),
  );
  await push.runPromise(Push.use((p) => p.enqueue(held)));
  suppressed.push(held);
  const groups = standaloneGroupChats(
    service,
    new GroupTranscripts(join(dir, "groups")),
  );
  const group = groups.create({ name: "Trip", memberIds: [agent.id] });
  const groupChat = { kind: "group" as const, id: group.id };
  await groups.post(group.id, "Plan the trip", id());
  await until(() =>
    activities.some((activity) => activity.groupId === group.id),
  );
  const groupActivity = activities.find(
    (activity) => activity.groupId === group.id,
  )!;
  const groupMessages = (await groups.history(group.id, { limit: 200 }))
    .messages;
  const groupMessage = groupMessages.find(
    (message) => message.content === "A group answer.",
  )!;
  expect(groupActivity.entryId).toBe(groupMessage.entryId);
  expect(groupMessage.replyReferences).toEqual([
    { eventId: groupActivity.executionId, surface: { kind: "text" } },
  ]);
  expect(
    (await groups.snapshot(group.id, { limit: 200 })).messages.find(
      (message) => message.id === groupMessage.id,
    )?.replyReferences,
  ).toEqual(groupMessage.replyReferences);
  expect(
    (await service.history(agent.id, { limit: 200 })).messages
      .flatMap((message) => message.replyReferences)
      .some((reference) => reference.eventId === groupActivity.executionId),
  ).toBe(false);
  await push.runPromise(
    ChatAttention.use((attention) =>
      attention.seen(groupChat, [groupActivity.executionId]),
    ),
  );
  await push.runPromise(Push.use((p) => p.enqueue(groupActivity)));
  await push.runPromise(
    ChatAttention.use((attention) =>
      Effect.gen(function* () {
        yield* attention.seen(
          chat,
          suppressed.map((activity) => activity.executionId),
        );
        yield* attention.seen(groupChat, [groupActivity.executionId]);
      }),
    ),
  );
  await groups.close();
  await service.close();
  await push.dispose();
  const reopened = openPush();
  await reopened.runPromise(
    Effect.gen(function* () {
      const p = yield* Push;
      for (const activity of suppressed) yield* p.enqueue(activity);
      yield* p.enqueue(groupActivity);
      yield* p.enqueue(secondActivity);
      yield* TestClock.adjust(3000);
      yield* p.drain;
    }),
  );
  expect(sent).toEqual([second.id]);
  await reopened.dispose();
});

test("a reply to a job report keeps its job name on the stream and in push payloads", () => {
  const event = canonicalReplyEvent(
    {
      executionId: "desktop-report:9",
      agentId: "a",
      agentName: "Desk",
      entryId: "a:3",
      origin: "desktop",
      jobName: "github-login",
      preview: "Please log in.",
      createdAt: "2026-10-21T00:00:00.000Z",
    },
    "server",
  );

  expect(event).toMatchObject({ origin: "desktop", jobName: "github-login" });
});
