import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect";
import { PROGRESS_BYTES_PER_SECOND } from "@earendil-works/chord/output";
import { ExecutionError, err, ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Store } from "../../test/support/store";
import { BotNotices } from "../bots/bot-notices";
import { Credentials } from "../credentials/credentials";
import {
  agentInput,
  scheduleInput,
  type Schedule,
  type ScriptRun,
} from "../shared/domain";
import {
  BotWorkspaces,
  WORKSPACE_PATH,
  type Workspaces,
} from "../workspaces/workspace";
import { DesktopNotConfigured } from "../workspaces/workspace-errors";
import { ScriptRunRepository } from "./script-run-repository";
import { ScriptRuns } from "./script-runs";
import type { ScriptEvent } from "../event-sources/event-payload";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

class DirectoryWorkspaces implements Workspaces {
  readonly desktop = false;
  readonly calls: Parameters<NodeExecutionEnv["exec"]>[] = [];
  readonly environments: { agentId: string; env: Record<string, string> }[] =
    [];
  readonly writes: { path: string; content: string }[] = [];
  active = 0;
  maxActive = 0;
  awake = 0;
  released = 0;

  constructor(readonly dir: string) {}

  env(agentId: string, shellEnv: Record<string, string> = {}) {
    this.environments.push({ agentId, env: shellEnv });
    const env = new NodeExecutionEnv({ cwd: this.dir, shellEnv });
    const exec = env.exec.bind(env);

    // Records files instead of writing to the host's absolute paths.
    env.writeFile = async (path, content) => {
      this.writes.push({ path, content: String(content) });

      return ok(undefined);
    };

    env.exec = async (command, options, context) => {
      this.calls.push([command, options, context]);
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);

      try {
        // Map the guest path to the test directory without touching the host's /workspace.
        return await exec(command, { ...options, cwd: this.dir }, context);
      } finally {
        this.active--;
      }
    };

    return env;
  }

  sync(_agentId: string) {
    return Effect.void;
  }

  restart(_agentId: string) {
    return Effect.void;
  }

  openDesktop(_agentId: string) {
    return Effect.fail(
      new DesktopNotConfigured({ message: "No bot desktop in this test" }),
    );
  }

  startDesktop(_agentId: string) {
    return Effect.void;
  }

  desktopRunning(_agentId: string) {
    return false;
  }

  keepAwake(_agentId: string) {
    this.awake++;

    return () => {
      this.awake--;
      this.released++;
    };
  }
}

type Notice = { agentId: string; text: string; requestId: string };

function open(
  options: {
    workspaces?: boolean;
    noticeFailure?: boolean;
    create?: (
      run: ScriptRun,
      create: Effect.Effect<void>,
    ) => Effect.Effect<void>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "crumble-script-runs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  cleanups.push(() => store.close());

  const agent = store.createAgent(
    agentInput.parse({ name: "Runner", tools: ["coding"] }),
  );

  const workspaces = new DirectoryWorkspaces(dir);
  const scope = store.run(Scope.make());
  const stop = () => store.runtime.runPromise(Scope.close(scope, Exit.void));
  cleanups.push(stop);
  const notices: Notice[] = [];

  store.run(
    BotNotices.use((botNotices) =>
      botNotices.handle((agentId, text, requestId) =>
        options.noticeFailure
          ? Effect.fail(new Error("notice unavailable"))
          : Effect.sync(() => notices.push({ agentId, text, requestId })),
      ),
    ).pipe(Scope.provide(scope)),
  );

  const repository = store.run(ScriptRunRepository);

  const context = store.run(
    Layer.buildWithScope(ScriptRuns.layer, scope).pipe(
      Effect.provideService(
        BotWorkspaces,
        options.workspaces === false ? undefined : workspaces,
      ),
      Effect.provideService(ScriptRunRepository, {
        ...repository,
        create: (run) =>
          options.create?.(run, repository.create(run)) ??
          repository.create(run),
      }),
    ),
  );

  const service = Context.get(context, ScriptRuns);

  const task = (command: string, patch: Partial<Schedule> = {}) =>
    store.createSchedule(
      scheduleInput.parse({
        agentId: agent.id,
        name: "Script task",
        kind: "script",
        command,
        runAt: "2099-01-01T00:00:00.000Z",
        notify: false,
        ...patch,
      }),
    );

  const start = (schedule: Schedule, event?: ScriptEvent) =>
    store.runtime.runPromise(service.start(schedule, event));

  const rows = (schedule: Schedule) =>
    store.run(repository.list(schedule.id, { limit: 20 }));

  const finished = async (schedule: Schedule) => {
    await until(
      () =>
        rows(schedule)[0]?.status !== "running" && rows(schedule).length > 0,
    );

    return rows(schedule)[0]!;
  };

  return {
    dir,
    store,
    agent,
    workspaces,
    stop,
    notices,
    service,
    repository,
    task,
    start,
    rows,
    finished,
  };
}

async function until(check: () => boolean) {
  const deadline = performance.now() + 2500;

  while (!check() && performance.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

function leftover(schedule: Schedule, startedAt: string): ScriptRun {
  return {
    id: crypto.randomUUID(),
    scheduleId: schedule.id,
    agentId: schedule.agentId,
    command: schedule.command!,
    status: "running",
    exitCode: null,
    output: "",
    droppedBytes: 0,
    error: null,
    startedAt,
    finishedAt: null,
  };
}

test("exit zero succeeds with combined output and uses workspace options and credentials", async () => {
  const { store, agent, workspaces, task, start, finished } = open();
  await store.runtime.runPromise(
    Credentials.use((credentials) =>
      credentials.save(agent.id, "SCRIPT_TOKEN", {
        hosts: ["example.invalid"],
        value: "test-only",
      }),
    ),
  );

  const schedule = task(
    'printf "out:"; printf "%s" "$SCRIPT_TOKEN"; printf ":err" >&2',
  );

  const admitted = await start(schedule);
  expect(admitted.admitted).toBe(true);
  expect(admitted.run?.status).toBe("running");
  const run = await finished(schedule);
  expect(run).toMatchObject({
    status: "succeeded",
    exitCode: 0,
    error: null,
    droppedBytes: 0,
  });
  expect(run.output).toContain("out:");
  expect(run.output).toContain(":err");
  expect(run.output).toContain("crumble-credential-");
  expect(run.output).not.toContain("test-only");
  expect(run.finishedAt).not.toBeNull();
  expect(workspaces.environments[0]?.agentId).toBe(agent.id);
  expect(workspaces.calls[0]?.[1]).toMatchObject({
    cwd: WORKSPACE_PATH,
    timeout: 600,
    window: {
      maxBytes: 65536,
      maxLines: 2000,
      minIntervalMs: 1000,
      bytesPerSecond: PROGRESS_BYTES_PER_SECOND,
    },
  });
  expect(workspaces.calls[0]?.[2].abortSignal).toBeInstanceOf(AbortSignal);
  expect(workspaces.awake).toBe(0);
  expect(workspaces.released).toBe(1);
});

test("a nonzero exit fails without retrying", async () => {
  const { workspaces, task, start, finished } = open();
  const schedule = task("printf failed; exit 3");
  await start(schedule);
  expect(await finished(schedule)).toMatchObject({
    status: "failed",
    exitCode: 3,
    output: "failed",
  });
  expect(workspaces.calls).toHaveLength(1);
});

test("a one-second timeout finishes in under three seconds", async () => {
  const { workspaces, task, start, finished } = open();
  const schedule = task("printf waiting; sleep 5", { timeoutSeconds: 1 });
  const before = performance.now();
  await start(schedule);
  expect(await finished(schedule)).toMatchObject({
    status: "timed_out",
    exitCode: null,
    output: "waiting",
  });
  expect(performance.now() - before).toBeLessThan(3000);
  expect(workspaces.awake).toBe(0);
});

test("a task cannot overlap itself and can start again after finishing", async () => {
  const { dir, task, start, finished, rows } = open();
  const schedule = task("while [ ! -f gate ]; do sleep 0.01; done");
  const starts = await Promise.all([start(schedule), start(schedule)]);
  expect(starts.map((result) => result.admitted)).toEqual([true, false]);
  expect(rows(schedule)).toHaveLength(1);
  writeFileSync(join(dir, "gate"), "");
  await finished(schedule);
  expect((await start(schedule)).admitted).toBe(true);
  await until(() => rows(schedule).every((row) => row.status === "succeeded"));
  expect(rows(schedule)).toHaveLength(2);
});

test("a fifth admitted run waits for an account permit", async () => {
  const { dir, workspaces, task, start, finished } = open();

  const schedules = Array.from({ length: 5 }, (_, i) =>
    task(`while [ ! -f gate-${i} ]; do sleep 0.01; done`),
  );

  for (const schedule of schedules.slice(0, 4)) await start(schedule);
  await until(() => workspaces.active === 4);
  expect((await start(schedules[4]!)).admitted).toBe(true);
  expect(workspaces.calls).toHaveLength(4);
  expect(workspaces.awake).toBe(4);
  writeFileSync(join(dir, "gate-0"), "");
  await until(() => workspaces.calls.length === 5);
  expect(workspaces.maxActive).toBe(4);

  for (let i = 1; i < 5; i++) writeFileSync(join(dir, `gate-${i}`), "");
  await Promise.all(schedules.map(finished));
});

test("large output keeps the last 64 KiB and counts dropped bytes", async () => {
  const { task, start, finished } = open();

  const schedule = task(
    "printf HEAD; head -c 100000 /dev/zero | tr '\\0' x; printf TAIL",
  );

  await start(schedule);
  const run = await finished(schedule);
  expect(run.status).toBe("succeeded");
  expect(Buffer.byteLength(run.output)).toBe(65536);
  expect(run.output.endsWith("TAIL")).toBe(true);
  expect(run.output).not.toContain("HEAD");
  expect(run.droppedBytes).toBe(100008 - 65536);
});

test("output also retains only the last 2000 lines", async () => {
  const { task, start, finished } = open();
  const schedule = task("seq 1 3000");
  await start(schedule);
  const run = await finished(schedule);
  expect(run.output.split("\n").filter(Boolean)).toHaveLength(2000);
  expect(run.output.startsWith("1001\n")).toBe(true);
  expect(run.output.endsWith("3000\n")).toBe(true);
  expect(run.droppedBytes).toBeGreaterThan(0);
});

test("a notice closes its output fence without a blank line", async () => {
  const { notices, task, start, finished } = open();
  const schedule = task("echo hello", { notify: true });
  await start(schedule);
  await finished(schedule);
  await until(() => notices.length === 1);
  expect(notices[0]!.text.endsWith("```\nhello\n```")).toBe(true);
});

test("notify false stays silent and notify true posts once with a bounded tail", async () => {
  const { agent, notices, task, start, finished } = open();
  const silent = task("printf silent");
  await start(silent);
  await finished(silent);
  expect(notices).toEqual([]);

  const schedule = task(
    "printf HEAD; head -c 10000 /dev/zero | tr '\\0' x; printf TAIL",
    { notify: true },
  );

  const { run } = await start(schedule);
  await finished(schedule);
  await until(() => notices.length === 1);
  expect(notices[0]).toMatchObject({
    agentId: agent.id,
    requestId: `script:${schedule.id}:${run!.id}`,
  });

  const [name, gap1, status, gap2, exitCode, gap3, fence, output, closing] =
    notices[0]!.text.split("\n");

  expect([name, gap1, status, gap2, exitCode, gap3, fence, closing]).toEqual([
    schedule.name,
    "",
    "Status: succeeded",
    "",
    "Exit code: 0",
    "",
    "```",
    "```",
  ]);
  expect(Buffer.byteLength(output!)).toBe(8192);
  expect(output!.endsWith("TAIL")).toBe(true);
  expect(output).not.toContain("HEAD");
});

test("a failed notice does not fail the run or block the next admission", async () => {
  const { task, start, finished, rows } = open({ noticeFailure: true });
  const schedule = task("true", { notify: true });
  await start(schedule);
  expect((await finished(schedule)).status).toBe("succeeded");
  expect((await start(schedule)).admitted).toBe(true);
  await until(
    () =>
      rows(schedule).length === 2 &&
      rows(schedule).every((run) => run.status === "succeeded"),
  );
});

test("closing the layer interrupts commands and runs waiting for a permit", async () => {
  const { workspaces, task, start, stop, rows } = open();

  const schedules = Array.from({ length: 5 }, () =>
    task("printf waiting; sleep 5"),
  );

  for (const schedule of schedules) await start(schedule);
  await until(() => workspaces.active === 4);
  await stop();

  for (const schedule of schedules)
    expect(rows(schedule)[0]).toMatchObject({
      status: "interrupted",
      exitCode: null,
      finishedAt: expect.any(String),
    });
  expect(workspaces.calls.every((call) => call[2].abortSignal?.aborted)).toBe(
    true,
  );
  expect(workspaces.awake).toBe(0);
  await until(() => workspaces.active === 0);
});

test("an immediate layer close still finalizes the admitted run", async () => {
  const { task, start, stop, rows } = open();
  const schedule = task("sleep 5");
  await start(schedule);
  await stop();
  expect(rows(schedule)[0]?.status).toBe("interrupted");
});

test("closing during create finalizes the row and refuses further admissions", async () => {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();

  const { store, task, start, stop, rows, workspaces } = open({
    create: (_run, create) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        yield* create;
      }),
  });

  const schedule = task("sleep 5");
  const admission = start(schedule);
  await store.runtime.runPromise(Deferred.await(entered));
  const closing = stop();
  await store.runtime.runPromise(Deferred.succeed(release, undefined));
  const result = await admission;
  await closing;
  expect(rows(schedule)[0]?.status).toBe("interrupted");
  expect(result.admitted).toBe(false);
  expect(workspaces.calls).toHaveLength(0);
  expect(await start(schedule)).toEqual({ admitted: false });
  const other = task("true");
  expect(await start(other)).toEqual({ admitted: false });
  expect(rows(other)).toEqual([]);
});

test("recover interrupts leftover running rows", async () => {
  const { store, service, repository, task, rows } = open();
  const schedule = task("true");
  store.run(repository.create(leftover(schedule, "2026-10-26T00:00:00.000Z")));
  await store.runtime.runPromise(service.recover);
  expect(rows(schedule)[0]).toMatchObject({
    status: "interrupted",
    finishedAt: expect.any(String),
  });
});

test("list prunes runs older than 90 days and forwards paging", async () => {
  const { store, service, repository, task } = open();
  const schedule = task("true");
  const now = Date.now();
  const old = leftover(schedule, new Date(now - 91 * 86400000).toISOString());
  const first = leftover(schedule, new Date(now - 86400000).toISOString());
  const last = leftover(schedule, new Date(now).toISOString());

  for (const run of [old, first, last]) store.run(repository.create(run));
  expect(
    await store.runtime.runPromise(service.list(schedule.id, { limit: 1 })),
  ).toEqual([last]);
  expect(
    await store.runtime.runPromise(
      service.list(schedule.id, { limit: 20, before: last.id }),
    ),
  ).toEqual([first]);
  expect(store.run(repository.list(schedule.id, { limit: 20 }))).toHaveLength(
    2,
  );
});

test("no workspaces records a failed run and posts its result", async () => {
  const { notices, task, start, finished } = open({ workspaces: false });
  const schedule = task("true", { notify: true });
  await start(schedule);
  expect(await finished(schedule)).toMatchObject({
    status: "failed",
    error: "workspace unavailable",
    exitCode: null,
  });
  expect(notices).toHaveLength(1);
  expect(notices[0]?.text).toContain("Status: failed");
});

test("turning coding off before execution records a failure", async () => {
  const { store, agent, workspaces, task, start, finished } = open();
  const schedule = task("true");
  store.updateAgent(agent.id, { tools: [] });
  await start(schedule);
  expect(await finished(schedule)).toMatchObject({
    status: "failed",
    error: "coding is turned off for this bot",
  });
  expect(workspaces.calls).toEqual([]);
});

test("environment output omissions are counted with the retained tail", async () => {
  const { dir, workspaces, task, start, finished } = open();
  workspaces.env = () => {
    const env = new NodeExecutionEnv({ cwd: dir });
    env.exec = async (_command, options, context) => {
      options?.onOutput?.("x".repeat(65537) + "TAIL", context, {
        stream: "stdout",
        skipped: { bytes: 200000, newlines: 0, endsWithNewline: false },
      });

      return ok({ exitCode: 0 });
    };

    return env;
  };

  const schedule = task("unused");
  await start(schedule);
  const run = await finished(schedule);
  expect(run.output).toBe("x".repeat(65532) + "TAIL");
  expect(run.droppedBytes).toBe(200005);
});

test("an execution error result records its message", async () => {
  const { dir, workspaces, task, start, finished } = open();
  workspaces.env = () => {
    const env = new NodeExecutionEnv({ cwd: dir });
    env.exec = async () =>
      err(new ExecutionError("spawn_error", "shell failed"));

    return env;
  };

  const schedule = task("unused");
  await start(schedule);
  expect(await finished(schedule)).toMatchObject({
    status: "failed",
    error: "shell failed",
    exitCode: null,
  });
});

test("a workspace exception records its message and releases keepAwake", async () => {
  const { workspaces, task, start, finished } = open();
  workspaces.env = () => {
    throw new Error("workspace boot failed");
  };

  const schedule = task("true");
  await start(schedule);
  expect(await finished(schedule)).toMatchObject({
    status: "failed",
    error: "workspace boot failed",
    exitCode: null,
  });
  expect(workspaces.awake).toBe(0);
  expect(workspaces.released).toBe(1);
});

test("an event script run gets the event in a file and its variables", async () => {
  const { workspaces, task, start, finished } = open();

  const schedule = task(
    'printf "%s|%s|%s" "$CRUMBLE_EVENT_ID" "$CRUMBLE_EVENT_SOURCE" "$CRUMBLE_EVENT_FILE"',
  );

  const record = {
    id: "01A",
    sourceId: "source-1",
    receivedAt: "2026-11-01T08:00:00.000Z",
    method: "POST",
    query: "a=1",
    headers: [["x-github-event", "issues"]] satisfies [string, string][],
    body: Buffer.from("{}").toString("base64"),
  };

  await start(schedule, { record, sourceName: "GitHub" });

  expect((await finished(schedule)).output).toBe(
    "01A|GitHub|/tmp/crumble-event-01A.json",
  );
  expect(workspaces.writes).toEqual([
    {
      path: "/tmp/crumble-event-01A.json",
      content: JSON.stringify({ ...record, sourceName: "GitHub" }),
    },
  ]);
});
