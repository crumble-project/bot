import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Exit } from "effect";
import { Store } from "../../test/support/store";
import { agentInput, scheduleInput, type ScriptRun } from "../shared/domain";
import { ScheduleRepository } from "./schedule-repository";
import { ScriptRunRepository } from "./script-run-repository";

const stores: { store: Store; dir: string }[] = [];

afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "crumble-script-runs-"));
  const store = new Store(dir);
  stores.push({ store, dir });
  const agent = store.createAgent(agentInput.parse({ name: "Ada" }));

  const schedule = store.createSchedule(
    scheduleInput.parse({
      agentId: agent.id,
      name: "Script",
      kind: "script",
      command: "echo hello",
      cron: "* * * * *",
    }),
  );

  const repository = store.run(ScriptRunRepository);

  const run = (id: string, startedAt: string): ScriptRun => ({
    id,
    scheduleId: schedule.id,
    agentId: agent.id,
    command: "echo hello",
    status: "running",
    exitCode: null,
    output: "",
    droppedBytes: 0,
    error: null,
    startedAt,
    finishedAt: null,
  });

  return { store, repository, schedule, run };
};

const first = "2026-10-26T10:00:00.000Z";
const second = "2026-10-26T11:00:00.000Z";
const third = "2026-10-26T12:00:00.000Z";

describe("ScriptRunRepository", () => {
  test("creates, finishes and lists runs newest first with exclusive paging", () => {
    const { store, repository, schedule, run } = setup();
    const oldest = run("oldest", first);
    store.run(repository.create(oldest));
    store.run(repository.create(run("newest", third)));
    store.run(repository.create(run("middle", second)));
    expect(store.run(repository.list(schedule.id, { limit: 2 }))).toEqual([
      run("newest", third),
      run("middle", second),
    ]);
    expect(
      store.run(repository.list(schedule.id, { limit: 2, before: "middle" })),
    ).toEqual([oldest]);
    expect(store.run(repository.list("other", { limit: 20 }))).toEqual([]);

    const result = {
      status: "failed" as const,
      exitCode: 3,
      output: "hello",
      droppedBytes: 10,
      error: "command failed",
      finishedAt: second,
    };

    store.run(repository.finish(oldest.id, result));
    expect(
      store.run(repository.list(schedule.id, { limit: 1, before: "middle" })),
    ).toEqual([{ ...oldest, ...result }]);
  });

  test("run ID cursors preserve ties and are scoped to the schedule", () => {
    const { store, repository, schedule, run } = setup();

    for (const id of ["a", "b", "c"])
      store.run(repository.create(run(id, second)));
    store.run(repository.create(run("older", first)));
    const page = store.run(repository.list(schedule.id, { limit: 2 }));
    expect(page.map((row) => row.id)).toEqual(["c", "b"]);
    expect(
      store
        .run(repository.list(schedule.id, { limit: 2, before: page[1]!.id }))
        .map((row) => row.id),
    ).toEqual(["a", "older"]);
    expect(
      store.run(repository.list(schedule.id, { limit: 2, before: "unknown" })),
    ).toEqual([]);

    const other = store.createSchedule(
      scheduleInput.parse({ ...schedule, name: "Other" }),
    );

    store.run(
      repository.create({ ...run("foreign", third), scheduleId: other.id }),
    );
    expect(
      store.run(repository.list(schedule.id, { limit: 2, before: "foreign" })),
    ).toEqual([]);
  });

  test("interrupts only running rows and prunes strictly older runs", () => {
    const { store, repository, schedule, run } = setup();
    store.run(repository.create(run("old", first)));
    store.run(repository.create(run("finished", second)));
    store.run(repository.create(run("running", third)));

    const result = {
      status: "succeeded" as const,
      exitCode: 0,
      output: "ok",
      droppedBytes: 0,
      error: null,
      finishedAt: second,
    };

    store.run(repository.finish("finished", result));
    store.run(repository.interruptRunning(third));
    expect(store.run(repository.list(schedule.id, { limit: 20 }))).toEqual([
      { ...run("running", third), status: "interrupted", finishedAt: third },
      { ...run("finished", second), ...result },
      { ...run("old", first), status: "interrupted", finishedAt: third },
    ]);
    store.run(repository.prune(second));
    expect(
      store
        .run(repository.list(schedule.id, { limit: 20 }))
        .map((row) => row.id),
    ).toEqual(["running", "finished"]);
  });

  test("deleting a schedule cascades to its runs", () => {
    const { store, repository, schedule, run } = setup();
    store.run(repository.create(run("run", first)));
    store.run(
      ScheduleRepository.use((schedules) => schedules.delete(schedule.id)),
    );
    expect(store.run(repository.list(schedule.id, { limit: 20 }))).toEqual([]);
  });

  test("schedule repository persists the new fields and clears script prompts", () => {
    const { store, schedule } = setup();
    expect(schedule).toMatchObject({
      kind: "script",
      command: "echo hello",
      prompt: "",
      timeoutSeconds: 600,
      notify: true,
    });

    const updated = store.run(
      ScheduleRepository.use((repository) =>
        repository.update(schedule.id, {
          command: "exit 3",
          timeoutSeconds: 12,
          notify: false,
          prompt: "ignored",
        }),
      ),
    );

    expect(updated).toMatchObject({
      kind: "script",
      command: "exit 3",
      prompt: "",
      timeoutSeconds: 12,
      notify: false,
    });
  });

  test("schedule updates reject invalid merged content without persisting it", () => {
    const { store, schedule } = setup();

    const result = store.run(
      Effect.exit(
        ScheduleRepository.use((repository) =>
          repository.update(schedule.id, { kind: "prompt" }),
        ),
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(store.getSchedule(schedule.id)).toEqual(schedule);
  });

  test("converting a script to a prompt clears its command", () => {
    const { store, schedule } = setup();

    const updated = store.run(
      ScheduleRepository.use((repository) =>
        repository.update(schedule.id, {
          kind: "prompt",
          prompt: "Check results",
        }),
      ),
    );

    expect(updated).toMatchObject({
      kind: "prompt",
      prompt: "Check results",
      command: null,
    });
  });

  test("schedule input validates kinds and timeout bounds", () => {
    const base = {
      agentId: crypto.randomUUID(),
      name: "Task",
      cron: "* * * * *",
    };

    expect(scheduleInput.parse({ ...base, prompt: "hello" })).toMatchObject({
      kind: "prompt",
      command: null,
      timeoutSeconds: 600,
      notify: true,
    });

    for (const input of [
      base,
      { ...base, prompt: "hello", command: "echo hello" },
      { ...base, kind: "script" },
      { ...base, kind: "script", command: " " },
      { ...base, kind: "script", command: "x".repeat(8001) },
      ...[0, 3601, 1.5].map((timeoutSeconds) => ({
        ...base,
        prompt: "hello",
        timeoutSeconds,
      })),
    ]) {
      expect(scheduleInput.safeParse(input).success).toBe(false);
    }

    expect(
      scheduleInput.safeParse({
        ...base,
        kind: "script",
        command: "echo hello",
        timeoutSeconds: 3600,
      }).success,
    ).toBe(true);
  });
});
