import { parseRequestId, scheduleRequest } from "../shared/request-ids";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schedule as Cadence,
} from "effect";
import type { z } from "zod";
import {
  hasBareWeekdayStep,
  nextOccurrence,
  validTimezone,
} from "../contract/cron";
import { BOT_TOOL } from "../contract/tools";
import {
  scheduleInput,
  mergeScheduleInput,
  type Schedule,
  type ScheduleInput,
} from "../shared/domain";
import { AgentRepository } from "../bots/agent-repository";
import { EventRepository } from "../event-sources/event-repository";
import type { Runner } from "../shared/runner";
import { BotWorkspaces } from "../workspaces/workspace";
import {
  Automations,
  automationOn,
  RETRY_AFTER_MS,
  type AutomationStarted,
} from "./automations";
import { ScheduleRepository } from "./schedule-repository";
import {
  Forbidden,
  InvalidInput,
  NotFound,
  Conflict,
  type AppError,
  errorText,
} from "../shared/errors";

const nextRun = (cron: string, timezone: string, from: Date) =>
  nextOccurrence(cron, timezone, from).toISOString();

const parsed = (input: ScheduleInput) =>
  Effect.try({
    try: () => mergeScheduleInput(scheduleInput.parse(input), {}),
    // SAFETY: scheduleInput.parse and mergeScheduleInput throw only ZodError.
    catch: (error) => error as z.ZodError,
  });

/** Checks the time fields `parsed` cannot and answers when the schedule next runs. */
const firstRun = (value: ScheduleInput) =>
  Effect.try({
    try: () => {
      if (!validTimezone(value.timezone))
        throw new Error(`Invalid timezone: ${value.timezone}`);

      if (!value.cron) return value.runAt;

      if (hasBareWeekdayStep(value.cron))
        throw new Error(
          `Weekday steps need * or a range, like 1-5/2: ${value.cron}`,
        );

      return nextRun(value.cron, value.timezone, new Date());
    },
    catch: (error) =>
      new InvalidInput({
        message: error instanceof Error ? error.message : "Invalid schedule",
      }),
  });

/** Persistent schedule coordinator. A dispatch that succeeds means the work was durably admitted. */
export class Scheduler extends Context.Service<
  Scheduler,
  {
    /** Who may give a bot a script task. `by` is the bot acting, or null for the owner. */
    readonly scriptPolicy: (
      agentId: string,
      by: string | null,
      createdByAgentId?: string | null,
    ) => Effect.Effect<void, AppError>;
    /** Input that does not parse fails with the ZodError, for each caller to word. */
    readonly create: (
      input: ScheduleInput,
      by?: string | null,
    ) => Effect.Effect<Schedule, AppError | z.ZodError>;
    readonly update: (
      id: string,
      input: Partial<ScheduleInput>,
      by?: string | null,
    ) => Effect.Effect<Schedule | null, AppError | z.ZodError>;
    /** Starts a task now; not admitted while a start of it is in flight. */
    readonly runNow: (id: string) => Effect.Effect<AutomationStarted, unknown>;
    /** Dispatches every due task once; a tick in progress is joined instead of repeated. */
    readonly tick: (now?: Date) => Effect.Effect<void>;
    /** Ticks now and then every interval, until `stop` or the scheduler's scope ends. */
    readonly start: Effect.Effect<void>;
    /** Stops ticking and waits for a tick in progress. */
    readonly stop: Effect.Effect<void>;
  }
>()("crumble/automations/Scheduler") {
  static layer(intervalMs = 1000) {
    return Layer.effect(
      Scheduler,
      Effect.gen(function* () {
        const schedules = yield* ScheduleRepository;
        const agents = yield* AgentRepository;
        const events = yield* EventRepository;
        const automations = yield* Automations;
        const workspaces = yield* BotWorkspaces;
        const scope = yield* Effect.scope;
        const failed = new Map<string, number>();
        let current: Deferred.Deferred<void> | undefined;
        let ticker: Fiber.Fiber<unknown, unknown> | undefined;

        const scriptPolicy = Effect.fn("Scheduler.scriptPolicy")(function* (
          agentId: string,
          by: string | null,
          createdByAgentId: string | null = null,
        ) {
          // A bot acts with its own tools; the owner with those of the bot the task runs on.
          const acting = yield* agents.get(by ?? agentId);

          if (!acting)
            return yield* new NotFound({ message: "Agent not found" });

          if (!acting.tools.includes(BOT_TOOL.coding))
            return yield* new Forbidden({
              message: "Script tasks need coding jobs",
            });

          if (
            (by && agentId !== by) ||
            (createdByAgentId && createdByAgentId !== agentId)
          )
            return yield* new Forbidden({
              message: "You can only give yourself a script task",
            });

          if (workspaces === undefined)
            return yield* new Conflict({
              message: "This server has no workspaces",
            });
        });

        const known = Effect.fnUntraced(function* (value: ScheduleInput) {
          if (!(yield* agents.get(value.agentId)))
            return yield* new NotFound({ message: "Agent not found" });

          if (
            value.eventSourceId &&
            !(yield* events.getSource(value.eventSourceId))
          )
            return yield* new NotFound({ message: "Event source not found" });
        });

        const create = Effect.fn("Scheduler.create")(function* (
          input: ScheduleInput,
          by: string | null = null,
        ) {
          const value = yield* parsed(input);

          if (value.kind === "script") yield* scriptPolicy(value.agentId, by);

          const nextRunAt = yield* firstRun(value);

          yield* known(value);

          return yield* schedules.create(value, nextRunAt, {
            createdByAgentId: by,
          });
        });

        const update = Effect.fn("Scheduler.update")(function* (
          id: string,
          input: Partial<ScheduleInput>,
          by: string | null = null,
        ) {
          const old = yield* schedules.get(id);

          if (!old)
            return yield* Effect.fail(
              new NotFound({ message: "Schedule not found" }),
            );
          const value = yield* parsed(mergeScheduleInput(old, input));

          if (value.kind === "script")
            yield* scriptPolicy(value.agentId, by, old.createdByAgentId);

          const nextRunAt = yield* firstRun(value);

          yield* known(value);
          const updated = yield* schedules.update(id, value, nextRunAt);

          if (!updated) return null;

          for (const key of failed.keys()) {
            const request = parseRequestId(key);

            if (request.kind === "schedule" && request.scheduleId === id)
              failed.delete(key);
          }

          return updated;
        });

        const logDispatchError = (scheduleId: string, cause: unknown) =>
          Effect.logError(
            `Schedule dispatch failed (${scheduleId}): ${errorText(cause)}`,
          );

        const runNow = Effect.fn("Scheduler.runNow")(function* (id: string) {
          const schedule = yield* schedules.get(id);

          if (!schedule)
            return yield* Effect.fail(
              new NotFound({ message: "Schedule not found" }),
            );
          const agent = yield* agents.get(schedule.agentId);

          if (!agent)
            return yield* Effect.fail(
              new NotFound({ message: "Agent not found" }),
            );

          if (!automationOn(schedule, agent))
            return yield* Effect.fail(
              new Conflict({ message: "Schedule or agent is disabled" }),
            );

          const due = new Date(yield* Clock.currentTimeMillis).toISOString();

          return yield* automations
            .start(schedule, { kind: "occurrence", due })
            .pipe(
              Effect.tapError((cause) => logDispatchError(schedule.id, cause)),
            );
        });

        const dispatchOnce = (
          schedule: Schedule,
          due: string,
          requestId: string,
          failedAt: number,
        ) =>
          automations.start(schedule, { kind: "occurrence", due }).pipe(
            Effect.map(({ admitted }) => admitted),
            Effect.catchCause((cause) =>
              logDispatchError(schedule.id, Cause.squash(cause)).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    failed.set(requestId, failedAt);

                    return false;
                  }),
                ),
              ),
            ),
          );

        const advancing = Effect.fnUntraced(function* (
          schedule: Schedule,
          now: Date,
        ) {
          const latest = yield* schedules.get(schedule.id);

          if (!latest) return;

          yield* schedules.updateNextRunAt(
            schedule.id,
            latest.cron ? nextRun(latest.cron, latest.timezone, now) : null,
          );
        });

        const retryWaiting = (key: string, now: Date) => {
          const failedAt = failed.get(key);

          return (
            failedAt !== undefined && now.valueOf() - failedAt < RETRY_AFTER_MS
          );
        };

        const passOne = Effect.fnUntraced(function* (
          schedule: Schedule,
          now: Date,
        ) {
          if (
            !schedule.nextRunAt ||
            !automationOn(schedule, yield* agents.get(schedule.agentId))
          )
            return;
          const due = new Date(schedule.nextRunAt);

          if (Number.isNaN(due.valueOf()) || due > now) return;
          const dueAt = due.toISOString();
          const key = scheduleRequest(schedule.id, dueAt);

          if (retryWaiting(key, now)) return;

          if (!(yield* dispatchOnce(schedule, dueAt, key, now.valueOf())))
            return;

          yield* advancing(schedule, now);
        });

        const pass = Effect.fnUntraced(function* (now: Date) {
          for (const schedule of yield* schedules.list())
            yield* passOne(schedule, now);
        });

        const tick = Effect.fn("Scheduler.tick")(function* (now?: Date) {
          if (current) return yield* Deferred.await(current);

          const done = yield* Deferred.make<void>();
          current = done;
          const at = now ?? new Date(yield* Clock.currentTimeMillis);

          // Uninterruptible, so stopping waits for a dispatch in progress to be recorded.
          yield* pass(at).pipe(
            Effect.uninterruptible,
            Effect.ensuring(
              Effect.gen(function* () {
                current = undefined;
                yield* Deferred.succeed(done, undefined);
              }),
            ),
          );
        });

        const logTickFailure = Effect.catchCause((cause: unknown) =>
          Effect.logError("Scheduler tick failed", cause),
        );

        const start = Effect.gen(function* () {
          if (ticker) return;

          ticker = yield* tick().pipe(
            logTickFailure,
            Effect.repeat(Cadence.fixed(intervalMs)),
            Effect.forkIn(scope),
          );
        });

        const stop = Effect.gen(function* () {
          const running = ticker;
          ticker = undefined;

          if (running) yield* Fiber.interrupt(running);

          if (current) yield* Deferred.await(current);
        });

        return Scheduler.of({
          scriptPolicy,
          create,
          update,
          runNow,
          tick,
          start,
          stop,
        });
      }),
    );
  }
}

/** The scheduler for code outside Effect, such as the HTTP handlers. */
export type SchedulerAccess = {
  create(input: ScheduleInput, by?: string | null): Schedule;
  update(
    id: string,
    input: Partial<ScheduleInput>,
    by?: string | null,
  ): Schedule | null;
  runNow(id: string): Promise<AutomationStarted>;
  tick(now?: Date): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

export function schedulerAccess(runtime: Runner<Scheduler>): SchedulerAccess {
  const scheduler = runtime.runSync(Scheduler.use(Effect.succeed));

  return {
    create: (input, by) => runtime.runSync(scheduler.create(input, by)),
    update: (id, input, by) => runtime.runSync(scheduler.update(id, input, by)),
    runNow: (id) => runtime.runPromise(scheduler.runNow(id)),
    tick: (now) => runtime.runPromise(scheduler.tick(now)),
    start: () => runtime.runSync(scheduler.start),
    stop: () => runtime.runPromise(scheduler.stop),
  };
}
