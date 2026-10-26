import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { standaloneScheduler } from "./scheduler";
import { ScriptRuns } from "./script-runs";
import type { Schedule, ScriptRun } from "../shared/domain";
import { Conflict, InvalidInput } from "../shared/errors";
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

const recordingScriptRuns = () => {
  const calls: Schedule[] = [];
  const runs: ScriptRun[] = [];
  let admitted = true;
  let fail = false;

  const service = ScriptRuns.of({
    start: (schedule) =>
      Effect.gen(function* () {
        calls.push(schedule);

        if (fail) return yield* new Conflict({ message: "temporary" });

        if (!admitted) return { admitted: false };

        const run: ScriptRun = {
          id: `run-${runs.length}`,
          scheduleId: schedule.id,
          agentId: schedule.agentId,
          command: schedule.command!,
          status: "running",
          exitCode: null,
          output: "",
          droppedBytes: 0,
          error: null,
          startedAt: "2026-10-17T00:00:00.000Z",
          finishedAt: null,
        };

        runs.push(run);

        return { admitted: true, run };
      }),
    recover: Effect.void,
    list: () => Effect.succeed(runs),
  });

  return {
    calls,
    runs,
    service,
    admit: (value: boolean) => {
      admitted = value;
    },
    fail: (value: boolean) => {
      fail = value;
    },
  };
};

const scriptInput = (agentId: string) => ({
  agentId,
  name: "script",
  kind: "script" as const,
  command: "sleep 100",
  timeoutSeconds: 600,
  notify: true,
  prompt: "",
  cron: null,
  timezone: "UTC",
  runAt: "2026-10-17T00:00:00.000Z",
  enabled: true,
});

describe("Scheduler", () => {
  test("converting a script requires a prompt and clears the old command", () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);
    const scheduler = standaloneScheduler(store.runtime, async () => undefined);
    const script = scheduler.create(scriptInput(agent.id));
    expect(() => scheduler.update(script.id, { kind: "prompt" })).toThrow(
      InvalidInput,
    );
    expect(store.getSchedule(script.id)?.kind).toBe("script");
    expect(
      scheduler.update(script.id, { kind: "prompt", prompt: "Check" }),
    ).toMatchObject({
      kind: "prompt",
      prompt: "Check",
      command: null,
    });
    store.close();
  });

  test("admits a due script without prompt dispatch or waiting for its run to finish", async () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);
    const scripts = recordingScriptRuns();
    const prompts: string[] = [];

    const scheduler = standaloneScheduler(
      store.runtime,
      async (_agent, prompt) => {
        prompts.push(prompt);
      },
      undefined,
      scripts.service,
    );

    const schedule = scheduler.create(scriptInput(agent.id));

    await scheduler.tick(new Date(schedule.runAt!));
    await scheduler.tick(new Date(schedule.runAt!));

    expect(scripts.calls.map(({ id }) => id)).toEqual([schedule.id]);
    expect(prompts).toEqual([]);
    expect(store.getSchedule(schedule.id)?.nextRunAt).toBeNull();
    expect(scripts.runs[0]?.status).toBe("running");
    expect(scripts.runs[0]?.finishedAt).toBeNull();
    store.close();
  }, 1000);

  test("leaves a non-admitted script due and retries next tick without backoff", async () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);
    const scripts = recordingScriptRuns();
    scripts.admit(false);

    const scheduler = standaloneScheduler(
      store.runtime,
      async () => undefined,
      undefined,
      scripts.service,
    );

    const schedule = scheduler.create(scriptInput(agent.id));
    const due = new Date(schedule.runAt!);

    await scheduler.tick(due);
    expect(store.getSchedule(schedule.id)?.nextRunAt).toBe(schedule.runAt);
    await scheduler.tick(new Date(due.valueOf() + 1000));
    expect(scripts.calls).toHaveLength(2);
    scripts.admit(true);
    await scheduler.tick(new Date(due.valueOf() + 2000));
    expect(scripts.calls).toHaveLength(3);
    expect(store.getSchedule(schedule.id)?.nextRunAt).toBeNull();
    store.close();
  });

  test("retries a script admission failure after the existing backoff", async () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);
    const scripts = recordingScriptRuns();
    scripts.fail(true);

    const scheduler = standaloneScheduler(
      store.runtime,
      async () => undefined,
      undefined,
      scripts.service,
    );

    const schedule = scheduler.create(scriptInput(agent.id));
    const due = new Date(schedule.runAt!);

    await scheduler.tick(due);
    expect(store.getSchedule(schedule.id)?.nextRunAt).toBe(schedule.runAt);
    scripts.fail(false);
    await scheduler.tick(new Date(due.valueOf() + 10_000));
    expect(scripts.calls).toHaveLength(1);
    await scheduler.tick(new Date(due.valueOf() + 30_000));
    expect(scripts.calls).toHaveLength(2);
    expect(store.getSchedule(schedule.id)?.nextRunAt).toBeNull();
    store.close();
  });

  test("runNow returns the script run admission without advancing its schedule", async () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);
    const scripts = recordingScriptRuns();
    const prompts: string[] = [];

    const scheduler = standaloneScheduler(
      store.runtime,
      async (_agent, prompt) => {
        prompts.push(prompt);
      },
      undefined,
      scripts.service,
    );

    const schedule = scheduler.create(scriptInput(agent.id));

    expect(await scheduler.runNow(schedule.id)).toEqual({
      admitted: true,
      result: { id: "run-0", status: "running" },
    });
    scripts.admit(false);
    expect(await scheduler.runNow(schedule.id)).toEqual({ admitted: false });
    expect(scripts.calls).toHaveLength(2);
    expect(prompts).toEqual([]);
    expect(store.getSchedule(schedule.id)?.nextRunAt).toBe(schedule.runAt);
    store.close();
  });

  test("standalone script tasks are not admitted without ScriptRuns", async () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);

    const scheduler = standaloneScheduler(store.runtime, async () => {
      throw new Error("unexpected prompt dispatch");
    });

    const schedule = scheduler.create(scriptInput(agent.id));

    await scheduler.tick(new Date(schedule.runAt!));
    expect(await scheduler.runNow(schedule.id)).toEqual({ admitted: false });
    expect(store.getSchedule(schedule.id)?.nextRunAt).toBe(schedule.runAt);
    store.close();
  });
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
      kind: "prompt",
      command: null,
      timeoutSeconds: 600,
      notify: true,
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
      kind: "prompt",
      command: null,
      timeoutSeconds: 600,
      notify: true,
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
        kind: "prompt",
        command: null,
        timeoutSeconds: 600,
        notify: true,
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
        kind: "prompt",
        command: null,
        timeoutSeconds: 600,
        notify: true,
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
      kind: "prompt",
      command: null,
      timeoutSeconds: 600,
      notify: true,
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
      kind: "prompt",
      command: null,
      timeoutSeconds: 600,
      notify: true,
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
      kind: "prompt",
      command: null,
      timeoutSeconds: 600,
      notify: true,
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
