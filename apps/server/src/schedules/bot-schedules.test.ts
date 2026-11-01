import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Forbidden } from "../shared/errors";
import { Effect } from "effect";
import type { Workspaces } from "../workspaces/workspace";
import { scheduleExtension, standaloneBotSchedules } from "./bot-schedules";
import { Store } from "../../test/support/store";
import { EventRepository } from "../event-sources/event-repository";

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

const workspaces: Workspaces = {
  desktop: false,
  env: () => {
    throw new Error("Policy tests never execute commands");
  },
  restart: () => Effect.void,
  openDesktop: () => Effect.die("No desktop in policy tests"),
  startDesktop: () => Effect.void,
  keepAwake: () => () => {},
  desktopRunning: () => false,
  sync: () => Effect.void,
};

function setup(backend?: Workspaces) {
  const dir = mkdtempSync(join(tmpdir(), "bot-schedules-"));
  dirs.push(dir);
  const store = new Store(dir);

  const { service, schedules, scheduler } = standaloneBotSchedules(
    store.runtime,
    async () => ({ id: "exec-1" }),
    undefined,
    backend,
  );

  return { store, service, schedules, scheduler };
}

const later = () => new Date(Date.now() + 60_000).toISOString();

describe("bot schedules", () => {
  test("script tasks need coding jobs and cannot target another bot, even with messaging", () => {
    const { store, schedules } = setup(workspaces);
    const plain = store.createAgent(input("Plain", ["schedule"]), uuid(1));

    const coder = store.createAgent(
      input("Coder", ["schedule", "coding", "delegate"]),
      uuid(2),
    );

    const draft = {
      name: "Check",
      kind: "script" as const,
      command: "echo ok",
      runAt: later(),
    };

    expect(() => schedules.create(plain.id, draft)).toThrow(
      "Script tasks need coding jobs",
    );
    expect(() =>
      schedules.create(coder.id, { ...draft, agentId: plain.id }),
    ).toThrow("You can only give yourself a script task");

    const task = schedules.create(coder.id, {
      ...draft,
      timeoutSeconds: 42,
      notify: false,
    });

    expect(task).toMatchObject({
      kind: "script",
      command: "echo ok",
      prompt: "",
      timeoutSeconds: 42,
      notify: false,
    });
    expect(schedules.list(coder.id)).toEqual([task]);
    expect(() =>
      schedules.update(coder.id, task.id, { agentId: plain.id }),
    ).toThrow("You can only give yourself a script task");
    store.close();
  });

  test("turning a prompt task into a script applies the same policy", () => {
    const { store, schedules } = setup(workspaces);
    const plain = store.createAgent(input("Plain", ["schedule"]), uuid(1));

    const coder = store.createAgent(
      input("Coder", ["schedule", "coding", "delegate"]),
      uuid(2),
    );

    const task = schedules.create(plain.id, {
      name: "Check",
      prompt: "Check",
      runAt: later(),
    });

    expect(() =>
      schedules.update(plain.id, task.id, {
        kind: "script",
        command: "echo ok",
      }),
    ).toThrow("Script tasks need coding jobs");

    const delegated = schedules.create(coder.id, {
      name: "Check",
      prompt: "Check",
      agentId: plain.id,
      runAt: later(),
    });

    expect(() =>
      schedules.update(coder.id, delegated.id, {
        kind: "script",
        command: "echo ok",
      }),
    ).toThrow("You can only give yourself a script task");

    const own = schedules.create(coder.id, {
      name: "Own",
      prompt: "Check",
      runAt: later(),
    });

    expect(
      schedules.update(coder.id, own.id, {
        kind: "script",
        command: "echo ok",
      }),
    ).toMatchObject({
      kind: "script",
      command: "echo ok",
      prompt: "",
      timeoutSeconds: 600,
      notify: true,
    });
    store.close();
  });

  test("script creation and conversion fail without workspaces", () => {
    const { store, schedules } = setup();

    const coder = store.createAgent(
      input("Coder", ["schedule", "coding"]),
      uuid(1),
    );

    const draft = {
      name: "Check",
      kind: "script" as const,
      command: "echo ok",
      runAt: later(),
    };

    expect(() => schedules.create(coder.id, draft)).toThrow(
      "This server has no workspaces",
    );

    const prompt = schedules.create(coder.id, {
      name: "Check",
      prompt: "Check",
      runAt: later(),
    });

    expect(() =>
      schedules.update(coder.id, prompt.id, {
        kind: "script",
        command: "echo ok",
      }),
    ).toThrow("This server has no workspaces");
    store.close();
  });

  test("an offset timestamp runs at the intended instant in the target chat", async () => {
    const { store } = setup();
    const self = store.createAgent(input("Self", ["schedule"]), uuid(1));
    const calls: unknown[][] = [];

    const { service, scheduler } = standaloneBotSchedules(
      store.runtime,
      async (...args) => {
        calls.push(args);
      },
    );

    // SAFETY: Schedule extensions expose their registered tool list.
    const tool = (scheduleExtension(self, service) as any).tools[0];

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
      kind: "prompt",
      command: null,
      timeoutSeconds: 600,
      notify: true,
      prompt: "Summarize",
      cron: null,
      timezone: "UTC",
      runAt: later(),
      eventSourceId: null,
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

  test("targets another bot only with messaging and hides everyone else's tasks", () => {
    const { store, schedules } = setup();
    const target = store.createAgent(input("Target", ["schedule"]), uuid(2));

    const source = store.createAgent(
      input("Source", ["schedule", "delegate"]),
      uuid(1),
    );

    const other = store.createAgent(input("Other", ["schedule"]), uuid(3));

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
      schedules.create(other.id, {
        agentId: target.id,
        name: "Nope",
        prompt: "x",
        runAt: later(),
      }),
    ).toThrow(Forbidden);
    expect(() =>
      schedules.update(other.id, task.id, { name: "Stolen" }),
    ).toThrow(/Task not found/);

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

  test("every bot can schedule, but a paused bot cannot", () => {
    const { store, service, schedules } = setup();
    const plain = store.createAgent(input("Plain", ["memory"]), uuid(1));
    expect(
      // SAFETY: Schedule extensions expose their registered tool list.
      (scheduleExtension(store.getAgent(plain.id)!, service) as any).tools,
    ).toHaveLength(1);

    const paused = store.createAgent(
      input("Paused", ["memory"], [], false),
      uuid(2),
    );

    expect(() =>
      schedules.create(paused.id, {
        name: "Later",
        prompt: "Ping",
        runAt: later(),
      }),
    ).toThrow(/Scheduling is turned off/);
    store.close();
  });

  test("the schedule tool saves a task for the calling bot", async () => {
    const { store, service } = setup();
    const self = store.createAgent(input("Self", ["schedule"]), uuid(1));
    // SAFETY: Schedule extensions expose their registered tool list.
    const tool = (scheduleExtension(self, service) as any).tools[0];

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

  test("a bot lists the event sources and creates an event automation on one", () => {
    const { store, schedules, service } = setup();
    const bot = store.createAgent(input("Ada", ["schedule"]), uuid(1));

    store.runtime.runSync(
      EventRepository.use((events) =>
        events.addSource({
          id: "source-1",
          name: "GitHub",
          createdAt: "2026-11-01T00:00:00.000Z",
        }),
      ),
    );

    expect(Effect.runSync(service.sources(bot.id))).toEqual([
      { id: "source-1", name: "GitHub" },
    ]);

    const task = schedules.create(bot.id, {
      name: "Triage",
      prompt: "Triage the issue",
      eventSourceId: "source-1",
    });

    expect(task).toMatchObject({
      eventSourceId: "source-1",
      cron: null,
      runAt: null,
      nextRunAt: null,
    });
    expect(
      schedules.update(bot.id, task.id, { cron: "0 9 * * *" }),
    ).toMatchObject({ cron: "0 9 * * *", eventSourceId: null });
    expect(() =>
      schedules.create(bot.id, {
        name: "Both",
        prompt: "x",
        cron: "0 9 * * *",
        eventSourceId: "source-1",
      }),
    ).toThrow("Choose a recurring cron, a one-time date, or an event source");
    store.close();
  });
});
