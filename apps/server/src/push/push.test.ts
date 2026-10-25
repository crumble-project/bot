import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { TestClock } from "effect/testing";
import { Push, PushDelivery } from "./push";
import {
  canonicalReplyEvent,
  notificationTitle,
  type PushDeviceInput,
  type ReplyPushEvent,
} from "./push-model";
import { PushRepository } from "./push-repository";
import {
  PermanentRejection,
  PushTransports,
  TemporaryFailure,
  type PushTransport,
} from "./push-transports";
import { BotActivity } from "../bots/bot-activity";
import type { Activity, ReplyActivity } from "../bots/bots";
import { Store } from "../../test/support/store";
import { standaloneBots } from "../bots/bots";
import { standaloneScheduler } from "../schedules/scheduler";
import { createAPI } from "../app/api";

// Plain header records, so they spread into the defaults.
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

const android = (token: string): PushDeviceInput => ({
  platform: "android",
  transport: "fcm",
  token,
  environment: "production",
  enabled: true,
});

const fcmOnly = (fcm: PushTransport) =>
  Layer.succeed(PushTransports, { apns: undefined, fcm });

/** Push and its repository on a test clock that starts at `startAt`. */
async function pushRuntime(
  dir: string,
  transports: Layer.Layer<PushTransports, never, PushRepository>,
  startAt = 0,
) {
  const runtime = ManagedRuntime.make(
    Push.layerNoDeps.pipe(
      Layer.provide(transports),
      Layer.provideMerge(PushRepository.layer(dir)),
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
      submit: async () => "submission",
      wait: async () => ({ status: "done" }),
      abort: async () => {},
      deleteAgent: async () => {},
    };

    const service = standaloneBots(store, runtime);
    const scheduler = standaloneScheduler(store.runtime, async () => {});

    const push = await pushRuntime(
      dir,
      fcmOnly({ send: () => Effect.succeed("delivered") }),
    );

    const app = createAPI(service, scheduler, token, undefined, {}, push);
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
        await request(`/v1/push/devices/${installationId}/presence`, {
          method: "PUT",
          body: JSON.stringify({ active: true, agentId: id() }),
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(`/v1/push/devices/${id()}/presence`, {
          method: "PUT",
          body: JSON.stringify({ active: true, agentId: id() }),
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

    const serverId = await first.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        const serverId = yield* store.serverId;
        yield* store.upsertDevice(installationId, ios("old"));
        expect(yield* store.setPresence(installationId, true, agentId)).toBe(
          true,
        );
        yield* store.upsertDevice(installationId, ios("new"));
        expect(
          Option.getOrThrow(yield* store.getDevice(installationId)).token,
        ).toBe("new");
        expect(yield* store.isSuppressed(installationId, agentId)).toBe(true);

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
    const sent: ReplyPushEvent[] = [];

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

    await push.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        yield* store.upsertDevice(installationId, android("token"));
        yield* store.setPresence(installationId, true, agentId);

        const service = yield* Push;

        yield* service.enqueue({
          ...reply(agentId, now),
          agentName: "Ada",
          entryId: "group-1:4",
          origin: "group",
          preview: "Booked.",
          groupId: "group-1",
          groupName: "Trip",
        });
        yield* service.drain;
      }),
    );

    expect(sent).toEqual([
      expect.objectContaining({
        groupId: "group-1",
        groupName: "Trip",
        origin: "group",
      }),
    ]);
    expect(notificationTitle(sent[0]!)).toBe("Ada in Trip");
    await push.dispose();
  });

  test("suppresses visible-agent replies and retries failed transport", async () => {
    const dir = tempDir("crumble-push-");
    const now = 1_000_000;
    const installationId = id();
    const agentId = id();
    const sent: string[] = [];
    let failures = 1;

    const push = await pushRuntime(
      dir,
      fcmOnly({
        send: (_device, event) =>
          failures--
            ? Effect.fail(new TemporaryFailure({ message: "temporary" }))
            : Effect.sync(() => {
                sent.push(event.eventId);

                return "delivered" as const;
              }),
      }),
      now,
    );

    await push.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        const service = yield* Push;
        yield* store.upsertDevice(installationId, android("token"));
        expect(yield* store.setPresence(installationId, true, agentId)).toBe(
          true,
        );

        yield* service.enqueue(reply(agentId, now));
        yield* service.drain;
        expect(sent).toHaveLength(0);
        failures = 0;

        // A different installation with no active presence receives the same event.
        yield* store.upsertDevice(id(), android("token-2"));
        yield* store.enqueue(
          canonicalReplyEvent(reply(agentId, now), service.serverId),
        );
        yield* TestClock.adjust(2000);
      }),
    );

    const drain = Push.use((service) => service.drain);
    await Promise.all([push.runPromise(drain), push.runPromise(drain)]);
    expect(sent).toHaveLength(1);
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

    await rejecting.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        const service = yield* Push;
        yield* store.upsertDevice(installationId, {
          ...android("old"),
        });
        yield* store.enqueue(
          canonicalReplyEvent(reply(agentId, now), service.serverId),
          100,
        );
        yield* TestClock.adjust(200);
        yield* service.drain;
        expect(
          Option.getOrThrow(yield* store.getDevice(installationId)).enabled,
        ).toBe(true);
      }),
    );
    await rejecting.dispose();

    let rotationAttempts = 0;
    let deliveredToken = "";

    // The device registers a new token while the send with its old one is in flight.
    const rotatingTransports = Layer.effect(
      PushTransports,
      Effect.gen(function* () {
        const store = yield* PushRepository;

        return {
          apns: undefined,
          fcm: {
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

    const rotating = await pushRuntime(dir, rotatingTransports, now + 200);

    await rotating.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        const service = yield* Push;
        yield* store.enqueue(
          canonicalReplyEvent(reply(agentId, now + 200), service.serverId),
        );
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

    await push.runPromise(
      Effect.gen(function* () {
        const store = yield* PushRepository;
        const service = yield* Push;
        yield* store.upsertDevice(installationId, android("token"));
        yield* store.enqueue(
          canonicalReplyEvent(reply(id(), now), service.serverId),
        );
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
      avatar: "bot",
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
      submit: async () => "submission",
      wait: async () => ({ status: "done" }),
      snapshot: async () => ({
        messages: [
          { role: "assistant", content: "hello from bot", entryId: "entry-1" },
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
    let delivered: ReplyPushEvent | undefined;

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
            Layer.provideMerge(PushRepository.layer(dir)),
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
    await service.send(chat.id, "question", id());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await push.runPromise(Push.use((p) => p.drain));
    expect(delivered?.eventId).toBeTruthy();
    expect(delivered?.entryId).toBe("entry-1");
    await push.dispose();
    await service.close();
  });
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
