import { CronExpressionParser } from "cron-parser";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Schedule as Cadence,
} from "effect";
import {
  AppError,
  scheduleInput,
  type Schedule,
  type ScheduleInput,
} from "../shared/domain";
import { AgentRepository } from "../bots/agent-repository";
import type { Runner } from "../shared/runner";
import { ScheduleRepository } from "./schedule-repository";
import { TaskDispatch, type ScheduleDispatchResult } from "./task-dispatch";

export type { ScheduleDispatchResult } from "./task-dispatch";

// A failed occurrence waits this long before it is dispatched again.
const RETRY_AFTER_MS = 30_000;

const nextOccurrence = (cron: string, timezone: string, from: Date) =>
  CronExpressionParser.parse(cron, { currentDate: from, tz: timezone })
    .next()
    .toDate()
    .toISOString();

const assertTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
};

const validate = (input: ScheduleInput) =>
  Effect.try({
    try: () => {
      const value = scheduleInput.parse(input);

      assertTimezone(value.timezone);

      if (value.cron) nextOccurrence(value.cron, value.timezone, new Date());

      return value;
    },
    catch: (error) =>
      new AppError(
        400,
        error instanceof Error ? error.message : "Invalid schedule",
      ),
  });

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** Persistent schedule coordinator. A dispatch that succeeds means the work was durably admitted. */
export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly create: (
      input: ScheduleInput,
      createdByAgentId?: string | null,
    ) => Effect.Effect<Schedule, AppError>;
    readonly update: (
      id: string,
      input: Partial<ScheduleInput>,
    ) => Effect.Effect<Schedule | null, AppError>;
    /** Dispatches a task now; not admitted while one of its dispatches is in flight. */
    readonly runNow: (
      id: string,
    ) => Effect.Effect<
      { admitted: boolean; result?: ScheduleDispatchResult },
      unknown
    >;
    /** Dispatches every due task once; a tick in progress is joined instead of repeated. */
    readonly tick: (now?: Date) => Effect.Effect<void>;
    /** Ticks now and then every interval, until `stop` or the scheduler's scope ends. */
    readonly start: Effect.Effect<void>;
    /** Stops ticking and waits for a tick in progress. */
    readonly stop: Effect.Effect<void>;
  }
>()("crumble/schedules/Scheduler") {
  static layer(intervalMs = 1000) {
    return Layer.effect(
      Scheduler,
      Effect.gen(function* () {
        const schedules = yield* ScheduleRepository;
        const agents = yield* AgentRepository;
        const dispatch = yield* TaskDispatch;
        const scope = yield* Effect.scope;
        const inFlight = new Set<string>();
        const failed = new Map<string, number>();
        let current: Deferred.Deferred<void> | undefined;
        let ticker: Fiber.Fiber<unknown, unknown> | undefined;

        const setInitialNext = Effect.fnUntraced(function* (
          schedule: Schedule,
        ) {
          const next = schedule.cron
            ? yield* Effect.try({
                try: () =>
                  nextOccurrence(schedule.cron!, schedule.timezone, new Date()),
                catch: (error) =>
                  new AppError(
                    400,
                    error instanceof Error ? error.message : "Invalid schedule",
                  ),
              })
            : schedule.runAt;

          return (
            (yield* schedules.updateNextRunAt(schedule.id, next)) ?? schedule
          );
        });

        const create = Effect.fn("Scheduler.create")(function* (
          input: ScheduleInput,
          createdByAgentId: string | null = null,
        ) {
          const value = yield* validate(input);

          if (!(yield* agents.get(value.agentId)))
            return yield* Effect.fail(new AppError(404, "Agent not found"));

          return yield* setInitialNext(
            yield* schedules.create(value, undefined, createdByAgentId),
          );
        });

        const update = Effect.fn("Scheduler.update")(function* (
          id: string,
          input: Partial<ScheduleInput>,
        ) {
          const old = yield* schedules.get(id);

          if (!old)
            return yield* Effect.fail(new AppError(404, "Schedule not found"));
          const value = yield* validate({ ...old, ...input });

          if (!(yield* agents.get(value.agentId)))
            return yield* Effect.fail(new AppError(404, "Agent not found"));
          const updated = yield* schedules.update(id, value);

          if (!updated) return null;

          for (const key of failed.keys())
            if (key.startsWith(`schedule:${id}:`)) failed.delete(key);

          return yield* setInitialNext(updated);
        });

        const logDispatchError = (scheduleId: string, cause: unknown) =>
          Effect.logError(
            `Schedule dispatch failed (${scheduleId}): ${errorText(cause)}`,
          );

        const runNow = Effect.fn("Scheduler.runNow")(function* (id: string) {
          const schedule = yield* schedules.get(id);

          if (!schedule)
            return yield* Effect.fail(new AppError(404, "Schedule not found"));
          const agent = yield* agents.get(schedule.agentId);

          if (!agent)
            return yield* Effect.fail(new AppError(404, "Agent not found"));

          if (!schedule.enabled || !agent.enabled)
            return yield* Effect.fail(
              new AppError(409, "Schedule or agent is disabled"),
            );

          if (inFlight.has(id)) return { admitted: false };
          const due = new Date(yield* Clock.currentTimeMillis).toISOString();
          inFlight.add(id);

          const result = yield* dispatch(
            schedule.agentId,
            schedule.prompt,
            `schedule:${id}:${due}`,
            schedule.id,
          ).pipe(
            Effect.tapError((cause) => logDispatchError(schedule.id, cause)),
            Effect.ensuring(Effect.sync(() => inFlight.delete(id))),
          );

          return { admitted: true, result };
        });

        const dispatchOnce = Effect.fnUntraced(function* (
          schedule: Schedule,
          requestId: string,
          failedAt: number,
        ) {
          if (inFlight.has(schedule.id)) return false;
          inFlight.add(schedule.id);

          return yield* dispatch(
            schedule.agentId,
            schedule.prompt,
            requestId,
            schedule.id,
          ).pipe(
            Effect.as(true),
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
            Effect.ensuring(Effect.sync(() => inFlight.delete(schedule.id))),
          );
        });

        const pass = Effect.fnUntraced(function* (now: Date) {
          for (const schedule of yield* schedules.list()) {
            if (
              !schedule.enabled ||
              !schedule.nextRunAt ||
              !(yield* agents.get(schedule.agentId))?.enabled
            )
              continue;
            const due = new Date(schedule.nextRunAt);

            if (Number.isNaN(due.valueOf()) || due > now) continue;
            const key = `schedule:${schedule.id}:${due.toISOString()}`;
            const failedAt = failed.get(key);

            if (
              (failedAt !== undefined &&
                now.valueOf() - failedAt < RETRY_AFTER_MS) ||
              inFlight.has(schedule.id)
            )
              continue;

            if (!(yield* dispatchOnce(schedule, key, now.valueOf()))) continue;
            const latest = yield* schedules.get(schedule.id);

            if (!latest) continue;

            yield* schedules.updateNextRunAt(
              schedule.id,
              latest.cron
                ? nextOccurrence(latest.cron, latest.timezone, now)
                : null,
            );
          }
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

        return Scheduler.of({ create, update, runNow, tick, start, stop });
      }),
    );
  }
}

/** The scheduler for code outside Effect, such as the HTTP handlers and the bots' task tool. */
export type SchedulerAccess = {
  create(input: ScheduleInput, createdByAgentId?: string | null): Schedule;
  update(id: string, input: Partial<ScheduleInput>): Schedule | null;
  runNow(
    id: string,
  ): Promise<{ admitted: boolean; result?: ScheduleDispatchResult }>;
  tick(now?: Date): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

export function schedulerAccess(runtime: Runner<Scheduler>): SchedulerAccess {
  const scheduler = runtime.runSync(Scheduler.use(Effect.succeed));

  return {
    create: (input, createdByAgentId) =>
      runtime.runSync(scheduler.create(input, createdByAgentId)),
    update: (id, input) => runtime.runSync(scheduler.update(id, input)),
    runNow: (id) => runtime.runPromise(scheduler.runNow(id)),
    tick: (now) => runtime.runPromise(scheduler.tick(now)),
    start: () => runtime.runSync(scheduler.start),
    stop: () => runtime.runPromise(scheduler.stop),
  };
}

/** A scheduler over the tasks `core` reaches, dispatching with `dispatch`, for an API or a test without an account. */
export function standaloneScheduler(
  core: Runner<ScheduleRepository | AgentRepository>,
  dispatch: (
    agentId: string,
    prompt: string,
    requestId: string,
    scheduleId: string,
  ) => Promise<ScheduleDispatchResult>,
  intervalMs?: number,
): SchedulerAccess {
  return schedulerAccess(
    ManagedRuntime.make(
      Scheduler.layer(intervalMs).pipe(
        Layer.provide(
          Layer.succeed(
            TaskDispatch,
            (agentId, prompt, requestId, scheduleId) =>
              Effect.tryPromise({
                try: () => dispatch(agentId, prompt, requestId, scheduleId),
                catch: (error) => error,
              }),
          ),
        ),
        Layer.provide(
          Layer.succeedContext(
            core.runSync(
              Effect.context<ScheduleRepository | AgentRepository>(),
            ),
          ),
        ),
      ),
    ),
  );
}
