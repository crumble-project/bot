# Script tasks implementation plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** A scheduled task can run a shell command in its bot's workspace instead of sending a prompt to the bot chat.

**Architecture:** A task gets a `kind` (`prompt` or `script`). The `Scheduler` keeps its sequential tick and its contract that a dispatch returns once the work is durably admitted. Prompt tasks still go through `TaskDispatch`. Script tasks go through a new `ScriptRuns` service, which records a `script_runs` row, forks the run into its own scope and returns at once. The forked run boots the workspace, runs the command with a timeout, stores the result and, if the task's `notify` flag is on, posts the result to the bot chat as a notice.

**Tech stack:** Effect 4.0.6 services and layers, Drizzle 1.0.0-rc.5 on SQLite, pi-durable `ExecutionEnv.exec`, chord `OutputBuffer`, Zod contract schemas, React web app.

## Global constraints

- Read `node_modules/effect/AGENTS.md` completely before writing Effect code (`apps/server/AGENTS.md`).
- Terms follow `GLOSSARY.md`: **Script task**, **Workspace**, **Bot chat**, **Credential**. "Sandbox", "cron job", and "routine" never appear in product language.
- Script tasks need the bot's `coding` tool. A bot creates a script task only for itself; neither a bot nor the owner can give one bot a script task created by another bot. The API rejects script tasks for bots without `coding`.
- Without a workspace backend (`BotWorkspaces` is `undefined`), creating a script task fails with `Conflict`. An existing script task fails each run with `workspace unavailable`.
- Commands run as given through the workspace shell in `/workspace`, with the bot's credential environment (`Credentials.env(agentId)`), as coding jobs do.
- Timeout: default 600 seconds, minimum 1, maximum 3600.
- Output: keep the last 64 KiB and 2000 lines of combined stdout and stderr (`OutputBuffer`, `retain: "tail"`).
- Concurrency: one run per task at a time; at most 4 runs per account at once. An occurrence whose task is still running is skipped, not queued.
- Failures (non-zero exit, timeout, workspace failure) are recorded on the run and never retried. The scheduler's 30-second retry covers only a failure to record the run.
- `notify` defaults to `true`. With it on, every finished run posts a notice to the bot chat.
- Run records are kept 90 days.
- A run interrupted by shutdown is recorded as `interrupted`. On startup, runs still `running` become `interrupted`.
- Measured on Railway and Microsandbox (2026-10-26): `exec`'s `timeout` and abort kill the command's whole process tree, grandchildren included. A process the script detaches with `setsid` survives. Document that; don't work around it.
- No new dependencies. CI unit tests stay under two minutes; nothing needing a VM runs in CI.
- Bump the contract minor version (3.1.0 to 3.2.0), add a `## Contract 3.2.0` changelog section, and regenerate `openapi/`.

## File map

| File | Responsibility |
| --- | --- |
| `apps/server/src/schedules/schema.ts` | Add `kind`, `command`, `timeout_seconds`, `notify` to `schedules`. |
| `apps/server/src/schedules/script-run-schema.ts` (new) | `script_runs` table. |
| `apps/server/drizzle.store.config.ts` | Register the new schema file. |
| `apps/server/drizzle/store/<timestamp>_script_tasks/` (generated) | Migration. |
| `apps/server/src/shared/domain.ts` | `scheduleInput` gains the new fields and their rules; `ScriptRun` type. |
| `apps/server/src/schedules/schedule-repository.ts` | Read and write the new columns. |
| `apps/server/src/schedules/script-run-repository.ts` (new) | Create, finish, list, recover, prune runs. |
| `apps/server/src/schedules/script-runs.ts` (new) | `ScriptRuns` service: admission, concurrency, execution, notice. |
| `apps/server/src/schedules/scheduler.ts` | Branch on `kind`; use `ScriptRuns` for script tasks. |
| `apps/server/src/schedules/bot-schedules.ts` | Policy and tool parameters for script tasks. |
| `apps/server/src/schedules/schedules-api.ts` | Policy on the owner's routes; run history route. |
| `apps/server/src/contract/api-contract.ts`, `api-responses.ts` | Contract fields and the run history route. |
| `apps/server/src/bots/bots-reads.ts` | Origin `script` for run notices. |
| `apps/server/src/shared/product-layer.ts` | Provide `ScriptRunRepository`. |
| `apps/server/src/app/tenant.ts` | Provide `ScriptRuns`; recover runs at startup. |
| `apps/web/features/schedules/tasks.tsx`, `apps/web/lib/api.ts` | Kind toggle, command, timeout, notify, run history. |
| `GLOSSARY.md`, `apps/docs/content/reference/glossary.md` | Term **Script task** (already added). |
| `apps/docs/content/concepts/schedules-and-integrations.md`, `apps/docs/content/clients/web.md`, `docs/architecture.md`, `CHANGELOG.md` | Docs. |

## Shared interfaces

```ts
// shared/domain.ts
export type ScheduleKind = "prompt" | "script";

export type ScriptRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "interrupted";

export type ScriptRun = {
  id: string;
  scheduleId: string;
  agentId: string;
  command: string;
  status: ScriptRunStatus;
  exitCode: number | null;
  /** Last 64 KiB / 2000 lines of combined output. */
  output: string;
  /** Bytes the tail window dropped. */
  droppedBytes: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};
```

`Schedule` gains `kind: ScheduleKind`, `command: string | null`, `timeoutSeconds: number`, `notify: boolean`. For `kind: "prompt"`, `prompt` is required and `command` is null. For `kind: "script"`, `command` is required (1 to 8000 characters) and `prompt` is stored as `""`.

```ts
// schedules/script-runs.ts
export class ScriptRuns extends Context.Service<
  ScriptRuns,
  {
    /** Records a run and starts it in the background. Not admitted while the task's previous run is in flight. */
    readonly start: (
      schedule: Schedule,
    ) => Effect.Effect<{ admitted: boolean; run?: ScriptRun }, AppError>;
    /** Marks runs left `running` by a previous process as `interrupted`. */
    readonly recover: Effect.Effect<void>;
    readonly list: (
      scheduleId: string,
      options: { limit: number; before?: string | undefined },
    ) => Effect.Effect<ScriptRun[]>;
  }
>()("crumble/schedules/ScriptRuns") {}
```

## Tasks

### Task 1: Schema, migration, domain, repositories

**Files:** `schedules/schema.ts`, `schedules/script-run-schema.ts` (new), `drizzle.store.config.ts`, generated migration, `shared/domain.ts`, `schedules/schedule-repository.ts`, `schedules/script-run-repository.ts` (new), `shared/product-layer.ts`, tests in `schedules/script-run-repository.test.ts` (new) and `shared/database.test.ts`.

- [ ] Add columns to `schedules`: `kind text not null default 'prompt'`, `command text`, `timeout_seconds integer not null default 600`, `notify integer (boolean) not null default 1`.
- [ ] Create `script_runs`: `id text pk`, `schedule_id text not null references schedules(id) on delete cascade`, `agent_id text not null`, `command text not null`, `status text not null`, `exit_code integer`, `output text not null default ''`, `dropped_bytes integer not null default 0`, `error text`, `started_at text not null`, `finished_at text`. Indexes `script_runs_by_schedule (schedule_id, started_at)` and `script_runs_by_time (started_at)`.
- [ ] Register the schema file in `drizzle.store.config.ts`; run `bunx drizzle-kit generate --config drizzle.store.config.ts` from `apps/server`. Inspect the SQL: existing rows must get `kind = 'prompt'`.
- [ ] Extend `scheduleInput` with `kind` (default `"prompt"`), `command` (nullable, max 8000), `timeoutSeconds` (int, 1 to 3600, default 600), `notify` (default `true`); `prompt` becomes `z.string().trim().max(32000).default("")`. Add a refine: prompt kind needs a non-empty prompt and no command; script kind needs a non-empty command.
- [ ] `ScheduleRepository`: map and write the new fields in `scheduleOf`, `create`, `update`.
- [ ] `ScriptRunRepository` (Effect service, `Effect.orDie` like the others): `create(run)`, `finish(id, { status, exitCode, output, droppedBytes, error, finishedAt })`, `list(scheduleId, { limit, before })` newest first, `interruptRunning(finishedAt)`, `prune(beforeIso)`.
- [ ] Tests: the migrated schema test in `shared/database.test.ts` still passes; the repository test covers create, finish, list order and paging, `interruptRunning`, `prune`, and cascade on schedule delete.
- [ ] Run `bun test apps/server/src/schedules apps/server/src/shared` from `bot`. Expected: pass.

### Task 2: `ScriptRuns` service

**Files:** `schedules/script-runs.ts` (new), `schedules/script-runs.test.ts` (new).
**Consumes:** `ScriptRunRepository`, `BotWorkspaces`, `Credentials`, `BotNotices`, `AgentRepository`.

- [ ] `start(schedule)`:
  1. If `inFlight` has `schedule.id`, return `{ admitted: false }`.
  2. Add the ID, then insert a `running` row (`startedAt` from `Clock`).
  3. Fork `execute(schedule, run)` with `Effect.forkIn(scope)` (the layer's scope), and return `{ admitted: true, run }`.
- [ ] `execute`:
  - Run inside `Semaphore.withPermit` on a 4-permit semaphore made in the layer.
  - When `BotWorkspaces` is `undefined`, or the agent no longer has `coding`, finish as `failed` with `error: "workspace unavailable"` or `"coding is turned off for this bot"`.
  - Otherwise:
    1. Hold `workspaces.keepAwake(agentId)`; release it in `Effect.ensuring`.
    2. Call `env(agentId, credentialsEnv).exec(command, { cwd: WORKSPACE_PATH, timeout: timeoutSeconds, onOutput, window }, context)` through `Effect.tryPromise({ try: (signal) => ... })`. The `context` is `withAbortSignal(signal, BACKGROUND_CONTEXT)`, so interruption aborts the command.
    3. Feed `onOutput` chunks (with `info.skipped`) into an `OutputBuffer({ maxBytes: 65536, maxLines: 2000, retain: "tail" })`.
    4. Pass `window: { maxBytes: 65536, maxLines: 2000, minIntervalMs: 1000, bytesPerSecond: PROGRESS_BYTES_PER_SECOND }`.
  - Status mapping:
    - `ok` with exit 0 becomes `succeeded`.
    - `ok` with any other exit becomes `failed` with that exit code.
    - Error `timeout` becomes `timed_out`.
    - Any other error becomes `failed`, with `error` set to its message.
  - Wrap everything in `Effect.onExit`. If the exit is interrupted (`Exit.hasInterrupts`), finish the run as `interrupted`. In every case, remove the ID from `inFlight`.
- [ ] Notice: after finishing, if `schedule.notify`, call `BotNotices.notice(agentId, text, \`script:${schedule.id}:${run.id}\`)`. Log a notice failure; never fail the run because of it. The text has four parts:
  1. The task name.
  2. The status.
  3. The exit code.
  4. The output tail in a fenced block, cut to the last 8 KiB for the chat.
- [ ] `recover`: `interruptRunning(now)`. `list`: prune runs older than 90 days, then list.
- [ ] Tests use a `DirectoryWorkspaces` fake with `NodeExecutionEnv` (copy the class from `jobs/jobs.test.ts`) and a `BotNotices` handler that collects notices:
  - Exit 0 is `succeeded` with its output.
  - `exit 3` is `failed` with exit code 3.
  - `sleep 5` with `timeoutSeconds: 1` is `timed_out` in under 3 seconds.
  - A second `start` while the first is running is not admitted.
  - A fifth concurrent run waits until a permit frees.
  - Output over 64 KiB keeps the tail and counts `droppedBytes`.
  - `notify: false` posts nothing; `notify: true` posts once, with request ID prefix `script:`.
  - Closing the layer while a run is running records `interrupted`.
  - `recover` marks a leftover `running` row as `interrupted`.
  - With no workspaces, the run is `failed` with `workspace unavailable`.
- [ ] Run `bun test apps/server/src/schedules/script-runs.test.ts`. Expected: pass in under 15 seconds.

### Task 3: Scheduler branches on kind

**Files:** `schedules/scheduler.ts`, `schedules/scheduler.test.ts`, `schedules/bot-schedules.ts` (`standaloneBotSchedules`).
**Consumes:** `ScriptRuns` from Task 2.

- [ ] `Scheduler.layer` requires `ScriptRuns`.
- [ ] In `dispatchOnce` and `runNow`, a script task calls `scriptRuns.start(schedule)`:
  - When the start is not admitted, `dispatchOnce` returns `false` without marking a failure, so the occurrence is skipped and `advancing` doesn't run. When `nextRunAt` is in the past and the task is still running, the next tick tries again. That is the skip-not-queue rule: after the run ends, the task runs once, then advances.
  - When admitted, it returns `true` and `advancing` runs.
  - A failure of `start` itself goes through the existing `failed` map and 30-second retry.
  - Prompt tasks are unchanged.
- [ ] `runNow` for a script task returns `{ admitted, result: { id: run.id, status: "running" } }`.
- [ ] `standaloneDependencies` gains an optional `ScriptRuns` argument and defaults to a stub that is never admitted, so existing callers compile unchanged.
- [ ] Tests (stub `ScriptRuns` that records calls):
  - A due script task calls `start` and not `TaskDispatch`.
  - When `start` is not admitted, `nextRunAt` stays and no failure is recorded.
  - A tick with a script task returns without waiting for the run (the stub's run never finishes).
  - Prompt tasks behave as before (existing tests).
- [ ] Run `bun test apps/server/src/schedules`. Expected: pass.

### Task 4: Policy, bot tool, owner API, contract

**Files:** `schedules/bot-schedules.ts`, `schedules/bot-schedules.test.ts`, `schedules/schedules-api.ts`, `contract/api-contract.ts`, `contract/api-responses.ts`, `bots/bots-reads.ts`, `app/api.test.ts`, `openapi/*` (generated), `CHANGELOG.md`.

- [ ] `BotSchedules.create` and `update`, when the resulting kind is `script`:
  - The source bot must have `coding`; otherwise fail with `Forbidden` and "Script tasks need coding jobs".
  - `agentId` must equal the source bot; otherwise fail with `Forbidden` and "You can only give yourself a script task".
  - No workspace backend fails with `Conflict` and "This server has no workspaces".
  - An update that turns a bot's own task into a script task, or retargets a script task, follows the same rules.
- [ ] Tool parameters: `kind`, `command` (max 8000), `timeoutSeconds` (1 to 3600), `notify`. Add one sentence to the description:

  > With kind script, the task runs command in your workspace (/workspace) on the schedule instead of sending a prompt, with your credentials; it runs only on you, needs coding jobs, and is killed after timeoutSeconds (default 600). With notify (default true) each run's result arrives in your chat.

  `PresentedTask` gains the four fields.
- [ ] Owner routes: `createSchedule` and `updateSchedule` reject a script task for a bot without `coding` (`Forbidden`), or when the server has no workspaces (`Conflict`).
- [ ] Add a route `GET /v1/schedules/{id}/runs?limit&before`, `operationId: "listScriptRuns"`, returning `ScriptRun[]`, with a `NotFound` for an unknown task.
- [ ] Contract: `scheduleResponse` and `scheduleInput` gain the fields. Add a `scriptRunResponse` (OpenAPI name `ScriptRun`). Bump `info.version` to `3.2.0`.
- [ ] `bots-reads.ts`: request ID prefix `script` maps to origin `{ kind: "script", name: <task name> }`. Document `script` in the `origin` description in `api-responses.ts`.
- [ ] Tests:
  - A bot without `coding` can't create a script task.
  - A bot with `coding` and `delegate` can't target another bot.
  - The owner API rejects a script task for a bot without `coding`.
  - The runs route returns runs newest first.
  - The notice origin is `script`.
- [ ] Run, from `bot`, in order: `bun run openapi:generate`, `bun run check`, `bun run contract:validate`, `bun run contract:compatibility`. Expected: all pass, and the compatibility check reports additive changes only.
- [ ] Add a `## Contract 3.2.0` section to `CHANGELOG.md` listing:
  - the new fields;
  - the runs route;
  - the `ScriptRun` schema;
  - origin kind `script`.

### Task 5: Account wiring and startup recovery

**Files:** `app/tenant.ts`, `app/multi-user.test.ts` or `app/server.test.ts`.

- [ ] Provide `ScriptRuns.layer` in `accountLayer`. It sits above `workspaces` and `base` (it needs `BotWorkspaces`, `Credentials` and `BotNotices`), and below `scheduler`, so it closes before the workspaces do. Provide it to `Scheduler.layer()`.
- [ ] At startup, after `bots.recover` and before `scheduler.start()`, run `yield* (yield* ScriptRuns).recover`.
- [ ] Pass `ScriptRuns` access to `registerScheduleRoutes` for the runs route.
- [ ] Test: an account with a fake `Workspaces` runs a due script task end to end: the run is recorded, a notice reaches the bot chat, and its origin is `script`.
- [ ] Run `bun run check`. Expected: pass; the CI unit test job stays under two minutes.

### Task 6: Web app

**Files:** `apps/web/features/schedules/tasks.tsx`, `apps/web/lib/api.ts`.

- [ ] In the task form, add a **Prompt / Script** tab after **Name**:
  - It is shown only when the selected bot has `coding` and `capabilities.coding` is true.
  - **Script** shows a monospace **Command** textarea (max 8000), **Timeout (seconds)** (default 600, 1 to 3600) and a **Send results to the chat** switch (default on), and hides **Prompt**.
- [ ] Task rows show the command in monospace for script tasks.
- [ ] Add a **Runs** disclosure per script task that lists the last 20 runs (`GET /v1/schedules/{id}/runs?limit=20`). Each run shows its status, exit code, start time, duration, and expandable output.
- [ ] Run `bun run check`. Expected: pass. Check the form by hand in the browser: create, edit, run now, pause.

### Task 7: Docs and live check

**Files:** `apps/docs/content/concepts/schedules-and-integrations.md`, `apps/docs/content/clients/web.md`, `docs/architecture.md`, `CHANGELOG.md`.

- [ ] Concepts page: add a "Script tasks" subsection. It covers:
  - what a script task does;
  - that it needs coding jobs and runs only on its own bot;
  - the timeout, and that a timeout kills the command's processes;
  - that processes started with `setsid` survive;
  - the output limit;
  - the notify flag;
  - that a run interrupted by a restart is recorded and not resumed.
- [ ] Web app page: the Tasks row mentions script tasks and their runs.
- [ ] `docs/architecture.md` under "Bot messaging and schedules": `ScriptRuns`, `script_runs`, and admission versus execution.
- [ ] `CHANGELOG.md` Unreleased: one entry for script tasks.
- [ ] Run `bun run check` in `apps/docs`. Expected: no problems, no broken links.
- [ ] Live check, local only, not in CI:
  1. With `CRUMBLE_RAILWAY_TESTS=1` and `.env.test.local`, and separately with `CRUMBLE_VM_TESTS=1 CRUMBLE_WORKSPACE_IMAGE=crumble-workspace:dev`, run a script task `python3 -c 'import time; time.sleep(30)'` with `timeoutSeconds: 3`.
  2. Expect a `timed_out` run within 5 seconds, and no `python3` left in `/proc`.
  3. Clean up the sandboxes and volumes the check created.

## Self-review

- Requirements and the tasks that cover them:

  | Requirement | Task |
  | --- | --- |
  | Coding gate and self-only | 4 |
  | Notify flag, default on | 1, 2, 6 |
  | Credentials | 2 |
  | Timeout of 600 seconds, capped at 3600 | 1, 2 |
  | One run per task, 4 per account | 2, 3 |
  | No retry on failure | 2, 3 |
  | 64 KiB output | 2 |
  | 90-day retention | 2 |
  | Restart recovery | 2, 5 |
  | No workspace | 2, 4 |
  | Contract | 4 |
  | Web | 6 |
  | Docs and glossary | 7 |
  | Live timeout check | 7 |

- Names used across tasks: `ScriptRuns.start`, `ScriptRuns.recover`, `ScriptRuns.list`, `ScriptRunRepository.interruptRunning`, `timeoutSeconds`, `notify`, request ID prefix `script:`, origin kind `script`.
