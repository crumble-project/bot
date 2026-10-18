import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  PushManager,
  PushStore,
  canonicalReplyEvent,
  type PushDevice,
  type ReplyPushEvent,
} from "../src/push";
import { Store } from "../src/store";
import { CrumbleService } from "../src/service";
import { Scheduler } from "../src/scheduler";
import { createAPI } from "../src/api";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const id = () => crypto.randomUUID();

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
    const dir = mkdtempSync(join("/tmp", "crumble-push-api-"));
    dirs.push(dir);
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
    const service = new CrumbleService(store, runtime);
    const scheduler = new Scheduler(store, async () => {});
    const pushStore = new PushStore(dir);
    const push = new PushManager(pushStore, {
      apns: undefined,
      fcm: { send: async () => "delivered" },
    });
    const app = createAPI(service, scheduler, token, undefined, {}, push);
    const installationId = id();
    const request = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    expect((await app.request("/v1/push")).status).toBe(401);
    const info = await request("/v1/push");
    expect(info.status).toBe(200);
    expect(((await info.json()) as any).serverId).toBe(push.serverId);
    expect(
      (
        await request(`/v1/push/devices/${installationId}`, {
          method: "PUT",
          body: JSON.stringify({
            platform: "macos",
            transport: "fcm",
            token: "x",
            environment: "production",
            enabled: true,
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/v1/push/devices/${installationId}`, {
          method: "PUT",
          body: JSON.stringify({
            platform: "android",
            transport: "fcm",
            token: "x",
            environment: "production",
            enabled: true,
          }),
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
    await push.close();
    scheduler.stop();
    store.close();
  });
  test("persists server ID and keeps presence across token rotation", () => {
    const dir = mkdtempSync(join("/tmp", "crumble-push-"));
    dirs.push(dir);
    const clock = () => 1_000_000;
    const first = new PushStore(dir, clock);
    const serverId = first.serverId();
    const installationId = id();
    const agentId = id();
    first.upsertDevice(installationId, {
      platform: "macos",
      transport: "apns",
      token: "old",
      environment: "development",
      bundleId: "com.example",
      enabled: true,
    });
    expect(first.setPresence(installationId, true, agentId)).toBe(true);
    first.upsertDevice(installationId, {
      platform: "macos",
      transport: "apns",
      token: "new",
      environment: "development",
      bundleId: "com.example",
      enabled: true,
    });
    expect(first.getDevice(installationId)?.token).toBe("new");
    expect(first.isSuppressed(installationId, agentId)).toBe(true);
    first.close();
    const second = new PushStore(dir, clock);
    expect(second.serverId()).toBe(serverId);
    expect(second.getDevice(installationId)?.token).toBe("new");
    second.close();
  });

  test("suppresses visible-agent replies and retries failed transport", async () => {
    const dir = mkdtempSync(join("/tmp", "crumble-push-"));
    dirs.push(dir);
    let now = 1_000_000;
    const store = new PushStore(dir, () => now);
    const installationId = id();
    const agentId = id();
    store.upsertDevice(installationId, {
      platform: "android",
      transport: "fcm",
      token: "token",
      environment: "production",
      enabled: true,
    });
    expect(store.setPresence(installationId, true, agentId)).toBe(true);
    const sent: string[] = [];
    let failures = 1;
    const transport = {
      send: async (_d: PushDevice, event: ReplyPushEvent) => {
        if (failures--) throw new Error("temporary");
        sent.push(event.eventId);
        return "delivered" as const;
      },
    };
    const manager = new PushManager(
      store,
      { fcm: transport, apns: undefined },
      () => now,
    );
    const service = {
      onActivity: (callback: (event: any) => void) => {
        callback({
          type: "reply",
          executionId: id(),
          agentId,
          agentName: "Bot",
          entryId: null,
          origin: "owner",
          preview: "hi",
          createdAt: new Date(now).toISOString(),
        });
        return () => {};
      },
    };
    manager.attach(service);
    await manager.drain();
    expect(sent).toHaveLength(0);
    failures = 0;
    // A different installation with no active presence receives the same event.
    const secondInstallation = id();
    store.upsertDevice(secondInstallation, {
      platform: "android",
      transport: "fcm",
      token: "token-2",
      environment: "production",
      enabled: true,
    });
    store.enqueue({
      type: "reply",
      eventId: id(),
      serverId: manager.serverId,
      agentId,
      agentName: "Bot",
      entryId: null,
      origin: "owner",
      preview: "hi",
      createdAt: new Date(now).toISOString(),
    });
    now += 2000;
    const first = manager.drain();
    const second = manager.drain();
    await Promise.all([first, second]);
    expect(sent).toHaveLength(1);
    await manager.close();
  });

  test("expires before send and does not disable a rotated token", async () => {
    const dir = mkdtempSync(join("/tmp", "crumble-push-"));
    dirs.push(dir);
    let now = 5_000;
    const store = new PushStore(dir, () => now);
    const installationId = id();
    const agentId = id();
    store.upsertDevice(installationId, {
      platform: "android",
      transport: "fcm",
      token: "old",
      environment: "production",
      enabled: true,
    });
    const manager = new PushManager(
      store,
      {
        fcm: {
          send: async () => {
            throw Object.assign(new Error("invalid"), { permanent: true });
          },
        },
        apns: undefined,
      },
      () => now,
    );
    store.enqueue(
      {
        type: "reply",
        eventId: id(),
        serverId: manager.serverId,
        agentId,
        agentName: "Bot",
        entryId: null,
        origin: "owner",
        preview: "x",
        createdAt: new Date(now).toISOString(),
      },
      100,
    );
    now += 200;
    await manager.drain();
    expect(store.getDevice(installationId)?.enabled).toBe(true);
    let rotationAttempts = 0;
    let deliveredToken = "";
    const rotatingManager = new PushManager(
      store,
      {
        fcm: {
          send: async (device) => {
            rotationAttempts++;
            store.upsertDevice(installationId, {
              platform: "android",
              transport: "fcm",
              token: "new",
              environment: "production",
              enabled: true,
            });
            if (rotationAttempts === 1)
              throw Object.assign(new Error("invalid"), { permanent: true });
            deliveredToken = device.token;
            return "delivered";
          },
        },
        apns: undefined,
      },
      () => now,
    );
    store.enqueue({
      type: "reply",
      eventId: id(),
      serverId: rotatingManager.serverId,
      agentId,
      agentName: "Bot",
      entryId: null,
      origin: "owner",
      preview: "x",
      createdAt: new Date(now).toISOString(),
    });
    await rotatingManager.drain();
    await rotatingManager.drain();
    expect(store.getDevice(installationId)?.token).toBe("new");
    expect(store.getDevice(installationId)?.enabled).toBe(true);
    expect(deliveredToken).toBe("new");
    await rotatingManager.close();
  });

  test("retries a transient delivery after backoff and bounds attempts", async () => {
    const dir = mkdtempSync(join("/tmp", "crumble-push-"));
    dirs.push(dir);
    let now = 10_000;
    const store = new PushStore(dir, () => now);
    const installationId = id();
    const agentId = id();
    store.upsertDevice(installationId, {
      platform: "android",
      transport: "fcm",
      token: "token",
      environment: "production",
      enabled: true,
    });
    let attempts = 0;
    const manager = new PushManager(
      store,
      {
        apns: undefined,
        fcm: {
          send: async () => {
            attempts++;
            if (attempts === 1) throw new Error("temporary");
            return "delivered";
          },
        },
      },
      () => now,
    );
    store.enqueue({
      type: "reply",
      eventId: id(),
      serverId: manager.serverId,
      agentId,
      agentName: "Bot",
      entryId: null,
      origin: "owner",
      preview: "reply",
      createdAt: new Date(now).toISOString(),
    });
    await manager.drain();
    expect(attempts).toBe(1);
    now += 500;
    await manager.drain();
    expect(attempts).toBe(1);
    now += 600;
    await manager.drain();
    expect(attempts).toBe(2);
    await manager.close();
  });

  test("delivers a completed reply through service activity without an SSE subscriber", async () => {
    const dir = mkdtempSync(join("/tmp", "crumble-push-service-"));
    dirs.push(dir);
    const store = new Store(dir);
    const agent = store.createAgent({
      name: "Bot",
      avatar: "bot",
      description: "",
      instructions: "help",
      provider: "openai",
      model: "gpt-4.1",
      enabled: true,
      folder: "Personal",
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
    const service = new CrumbleService(store, runtime);
    const pushStore = new PushStore(dir);
    const installationId = id();
    pushStore.upsertDevice(installationId, {
      platform: "android",
      transport: "fcm",
      token: "token",
      environment: "production",
      enabled: true,
    });
    let delivered: ReplyPushEvent | undefined;
    const manager = new PushManager(pushStore, {
      apns: undefined,
      fcm: {
        send: async (_device, event) => {
          delivered = event;
          return "delivered";
        },
      },
    });
    manager.attach(service);
    const chat = await service.chat(agent.id);
    await service.send(chat.id, "question", id());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await manager.drain();
    expect(delivered?.eventId).toBeTruthy();
    expect(delivered?.entryId).toBe("entry-1");
    await manager.close();
    await service.close();
  });
});
