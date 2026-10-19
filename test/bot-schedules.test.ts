import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../src/domain";
import { BotSchedules, scheduleExtension } from "../src/bot-schedules";
import { Scheduler } from "../src/scheduler";
import { Store } from "../src/store";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const input = (
  name: string,
  tools: string[],
  delegates: string[] = [],
  enabled = true,
) => ({
  name,
  avatar: "sparkles",
  description: "",
  instructions: "",
  provider: "openai" as const,
  model: "gpt-4.1",
  enabled,
  tools,
  skills: [],
  mcpServers: [],
  delegates,
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bot-schedules-"));
  dirs.push(dir);
  const store = new Store(dir);
  const scheduler = new Scheduler(store, async () => ({ id: "exec-1" }));

  return { store, schedules: new BotSchedules(store, scheduler), scheduler };
}

const later = () => new Date(Date.now() + 60_000).toISOString();

describe("bot schedules", () => {
  test("an offset timestamp runs at the intended instant in the target chat", async () => {
    const { store } = setup();
    const self = store.createAgent(input("Self", ["schedule"]), uuid(1));
    const calls: unknown[][] = [];

    const scheduler = new Scheduler(store, async (...args) => {
      calls.push(args);
    });

    const schedules = new BotSchedules(store, scheduler);
    // SAFETY: Schedule extensions expose their registered tool list.
    const tool = (scheduleExtension(self, schedules) as any).tools[0];

    try {
      const saved = await tool.execute({
        action: "create",
        name: "Berlin greeting",
        prompt: "Say hi",
        runAt: "2026-10-18T12:10:00+02:00",
        timezone: "Europe/Berlin",
      });

      const task = JSON.parse(saved.output[0].text);
      expect(task.runAt).toBe("2026-10-18T10:10:00.000Z");
      expect(task.nextRunAt).toBe(task.runAt);
      await scheduler.tick(new Date("2026-10-18T10:09:59Z"));
      expect(calls).toHaveLength(0);
      await scheduler.tick(new Date("2026-10-18T10:10:00Z"));
      expect(calls).toEqual([
        [self.id, "Say hi", `schedule:${task.id}:${task.runAt}`, task.id],
      ]);
      await scheduler.tick(new Date("2026-10-18T12:10:00Z"));
      expect(calls).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("a bot schedules work for itself and can change an owner task that targets it", async () => {
    const { store, schedules, scheduler } = setup();
    const self = store.createAgent(input("Self", ["schedule"]), uuid(1));

    const owner = scheduler.create({
      agentId: self.id,
      name: "Digest",
      prompt: "Summarize",
      cron: null,
      timezone: "UTC",
      runAt: later(),
      enabled: true,
    });

    expect(owner.createdByAgentId).toBeNull();

    const created = schedules.create(self.id, {
      name: "Standup",
      prompt: "Prepare notes",
      cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin",
    });

    expect(created.agentId).toBe(self.id);
    expect(created.createdByAgentId).toBe(self.id);
    expect(created.agentName).toBe("Self");

    const paused = schedules.update(self.id, owner.id, { enabled: false });
    expect(paused.enabled).toBe(false);
    expect(
      schedules
        .list(self.id)
        .map((task) => task.id)
        .sort(),
    ).toEqual([created.id, owner.id].sort());
    const ran = await schedules.run(self.id, created.id);
    expect(ran.admitted).toBe(true);
    store.close();
  });

  test("targets another permitted bot and hides everyone else's tasks", () => {
    const { store, schedules } = setup();
    const target = store.createAgent(input("Target", ["schedule"]), uuid(2));

    const source = store.createAgent(
      input("Source", ["schedule", "delegate"], [target.id]),
      uuid(1),
    );

    const other = store.createAgent(input("Other", ["schedule"]), uuid(3));
    const denied = store.createAgent(input("Denied", []), uuid(4));

    const task = schedules.create(source.id, {
      agentId: target.id,
      name: "Research",
      prompt: "Check the inbox",
      runAt: later(),
    });

    expect(task.agentId).toBe(target.id);
    expect(store.getSchedule(task.id)?.agentId).toBe(target.id);
    expect(schedules.list(target.id).map((item) => item.id)).toEqual([task.id]);
    expect(schedules.list(source.id).map((item) => item.id)).toEqual([task.id]);
    expect(schedules.list(other.id)).toEqual([]);

    expect(() =>
      schedules.create(source.id, {
        agentId: denied.id,
        name: "Nope",
        prompt: "x",
        runAt: later(),
      }),
    ).toThrow(AppError);
    expect(() =>
      schedules.update(other.id, task.id, { name: "Stolen" }),
    ).toThrow(/Task not found/);
    expect(() =>
      schedules.update(source.id, task.id, { agentId: denied.id }),
    ).toThrow(/allowed to message/);

    const moved = schedules.update(source.id, task.id, { agentId: source.id });
    expect(moved.agentId).toBe(source.id);
    expect(store.getSchedule(task.id)?.agentId).toBe(source.id);
    expect(() => schedules.delete(target.id, task.id)).toThrow(
      /Task not found/,
    );
    expect(schedules.delete(source.id, task.id)).toEqual({
      deleted: true,
      id: task.id,
    });
    store.close();
  });

  test("refuses scheduling when the capability is off and when the tool is absent", () => {
    const { store, schedules } = setup();
    const quiet = store.createAgent(input("Quiet", ["memory"]), uuid(1));
    expect(() =>
      schedules.create(quiet.id, {
        name: "Later",
        prompt: "Ping",
        runAt: later(),
      }),
    ).toThrow(/Scheduling is turned off/);
    expect(
      // SAFETY: Schedule extensions expose their registered tool list.
      (scheduleExtension(store.getAgent(quiet.id)!, schedules) as any).tools,
    ).toEqual([]);
    store.close();
  });

  test("the schedule tool saves a task for the calling bot", async () => {
    const { store, schedules } = setup();
    const self = store.createAgent(input("Self", ["schedule"]), uuid(1));
    // SAFETY: Schedule extensions expose their registered tool list.
    const tool = (scheduleExtension(self, schedules) as any).tools[0];

    const saved = await tool.execute(
      {
        action: "create",
        name: "Reminder",
        prompt: "Send the note",
        runAt: later(),
      },
      { taskId: "t1" },
    );

    const body = JSON.parse(saved.output[0].text);
    expect(body.agentId).toBe(self.id);
    expect(body.createdByAgentId).toBe(self.id);
    const listed = await tool.execute({ action: "list" }, { taskId: "t2" });
    expect(JSON.parse(listed.output[0].text)).toHaveLength(1);
    store.close();
  });
});
