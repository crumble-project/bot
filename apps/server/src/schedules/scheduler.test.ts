import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standaloneScheduler } from "./scheduler";
import { Store } from "../../test/support/store";

const dirs: string[] = [];

const make = () => {
  const d = mkdtempSync(join(tmpdir(), "bot-scheduler-"));
  dirs.push(d);

  return d;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const agentInput = {
  name: "A",
  avatar: "sparkles",
  description: "",
  instructions: "",
  provider: "openai" as const,
  model: "gpt-4.1",
  enabled: true,
  tools: [],
  skills: [],
  mcpServers: [],
  delegates: [],
};

describe("Scheduler", () => {
  test("dispatches a due one-time schedule exactly once and persists completion", async () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);
    const calls: string[] = [];

    const scheduler = standaloneScheduler(
      store.runtime,
      async (_a, _p, requestId) => {
        calls.push(requestId);
      },
    );

    const due = new Date(Date.now() - 1_000).toISOString();

    const schedule = scheduler.create({
      agentId: agent.id,
      name: "once",
      prompt: "hello",
      cron: null,
      timezone: "UTC",
      runAt: due,
      enabled: true,
    });

    await scheduler.tick(new Date());
    await scheduler.tick(new Date());
    expect(calls).toEqual([`schedule:${schedule.id}:${due}`]);
    expect(store.getSchedule(schedule.id)?.nextRunAt).toBeNull();
    store.close();
  });

  test("coalesces missed recurring occurrences and skips disabled agents", async () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);
    const calls: string[] = [];

    const scheduler = standaloneScheduler(
      store.runtime,
      async (_a, _p, requestId) => {
        calls.push(requestId);
      },
    );

    const schedule = scheduler.create({
      agentId: agent.id,
      name: "cron",
      prompt: "hello",
      cron: "* * * * *",
      timezone: "UTC",
      runAt: null,
      enabled: true,
    });

    store.updateNextRunAt(
      schedule.id,
      new Date(Date.now() - 3 * 60_000).toISOString(),
    );
    await scheduler.tick(new Date());
    expect(calls).toHaveLength(1);
    expect(
      new Date(store.getSchedule(schedule.id)!.nextRunAt!).valueOf(),
    ).toBeGreaterThan(Date.now());
    store.updateAgent(agent.id, { enabled: false });
    await scheduler.tick(new Date(Date.now() + 120_000));
    expect(calls).toHaveLength(1);
    store.close();
  });

  test("rejects invalid timezone and cron expressions", () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);
    const scheduler = standaloneScheduler(store.runtime, async () => undefined);
    expect(() =>
      scheduler.create({
        agentId: agent.id,
        name: "bad",
        prompt: "x",
        cron: "* * * * *",
        timezone: "No/Such_Zone",
        runAt: null,
        enabled: true,
      }),
    ).toThrow();
    expect(() =>
      scheduler.create({
        agentId: agent.id,
        name: "bad",
        prompt: "x",
        cron: "nope",
        timezone: "UTC",
        runAt: null,
        enabled: true,
      }),
    ).toThrow();
    store.close();
  });

  test("retries a failed dispatch with the same occurrence key after backoff", async () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);
    const calls: string[] = [];
    let attempts = 0;

    const scheduler = standaloneScheduler(
      store.runtime,
      async (_a, _p, requestId) => {
        calls.push(requestId);

        if (++attempts === 1) throw new Error("temporary");
      },
    );

    const due = new Date("2026-10-17T00:00:00.000Z");

    const schedule = scheduler.create({
      agentId: agent.id,
      name: "retry",
      prompt: "hello",
      cron: null,
      timezone: "UTC",
      runAt: due.toISOString(),
      enabled: true,
    });

    await scheduler.tick(due);
    await scheduler.tick(new Date(due.valueOf() + 10_000));
    await scheduler.tick(new Date(due.valueOf() + 31_000));
    expect(calls).toEqual([
      `schedule:${schedule.id}:${due.toISOString()}`,
      `schedule:${schedule.id}:${due.toISOString()}`,
    ]);
    expect(store.getSchedule(schedule.id)?.nextRunAt).toBeNull();
    store.close();
  });

  test("stopping waits for a dispatch in progress and records it", async () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    const scheduler = standaloneScheduler(
      store.runtime,
      async () => {
        started.resolve();
        await release.promise;
      },
      10,
    );

    const schedule = scheduler.create({
      agentId: agent.id,
      name: "once",
      prompt: "hello",
      cron: null,
      timezone: "UTC",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      enabled: true,
    });

    scheduler.start();
    await started.promise;

    let stopped = false;

    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });

    await Bun.sleep(30);
    expect(stopped).toBe(false);

    release.resolve();
    await stopping;
    expect(store.getSchedule(schedule.id)?.nextRunAt).toBeNull();
    store.close();
  });

  test("nothing is dispatched once stopped", async () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);
    const calls: string[] = [];

    const scheduler = standaloneScheduler(
      store.runtime,
      async (_a, _p, requestId) => {
        calls.push(requestId);
      },
      10,
    );

    scheduler.start();
    await scheduler.stop();

    scheduler.create({
      agentId: agent.id,
      name: "once",
      prompt: "hello",
      cron: null,
      timezone: "UTC",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      enabled: true,
    });

    await Bun.sleep(50);
    expect(calls).toEqual([]);
    store.close();
  });
});
