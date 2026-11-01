import { Cause, Clock, Context, Effect, Layer } from "effect";
import { AgentRepository } from "../bots/agent-repository";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { TaskDispatch } from "../schedules/task-dispatch";
import { startTicking } from "../shared/ticker";
import { EventRepository, type EventRun } from "./event-repository";
import { eventRequestId } from "./event-payload";

// A failed run waits this long before it is dispatched again, like a failed scheduled run.
export const EVENT_RETRY_AFTER_MS = 30_000;

export const EVENT_MAX_ATTEMPTS = 10;

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** Hands each automation's oldest pending event run to its bot chat, one run per automation at a time. */
export class EventDispatcher extends Context.Service<
  EventDispatcher,
  {
    readonly tick: Effect.Effect<void>;
    /** Ticks every second until the account closes. */
    readonly start: Effect.Effect<void>;
  }
>()("crumble/event-sources/EventDispatcher") {
  static readonly layer = Layer.effect(
    EventDispatcher,
    Effect.gen(function* () {
      const events = yield* EventRepository;
      const schedules = yield* ScheduleRepository;
      const agents = yield* AgentRepository;
      const dispatch = yield* TaskDispatch;
      const scope = yield* Effect.scope;
      const failedAt = new Map<string, number>();

      const failed = Effect.fnUntraced(function* (
        run: EventRun,
        cause: unknown,
      ) {
        const attempts = run.attempts + 1;
        const error = errorText(cause);

        yield* Effect.logError(`Event run failed (${run.id}): ${error}`);

        if (attempts >= EVENT_MAX_ATTEMPTS) {
          failedAt.delete(run.id);

          return yield* events.markRun(run.id, {
            status: "failed",
            attempts,
            error,
          });
        }

        failedAt.set(run.id, yield* Clock.currentTimeMillis);
        yield* events.markRun(run.id, { status: "pending", attempts, error });
      });

      const dispatchRun = Effect.fnUntraced(function* (run: EventRun) {
        const schedule = yield* schedules.get(run.scheduleId);
        const agent = schedule && (yield* agents.get(schedule.agentId));

        if (!schedule?.enabled || !agent?.enabled)
          return yield* events.markRun(run.id, {
            status: "failed",
            error: "The automation or its bot was turned off",
          });

        // Script automations on events arrive in a later change.
        if (schedule.kind === "script") return;

        yield* dispatch(
          schedule.agentId,
          schedule.prompt,
          eventRequestId(run.eventId, schedule.id),
          schedule.id,
        ).pipe(
          Effect.andThen(events.markRun(run.id, { status: "dispatched" })),
          Effect.andThen(Effect.sync(() => failedAt.delete(run.id))),
          Effect.catchCause((cause) => failed(run, Cause.squash(cause))),
        );
      });

      const waiting = (run: EventRun, now: number) => {
        const at = failedAt.get(run.id);

        return at !== undefined && now - at < EVENT_RETRY_AFTER_MS;
      };

      const tick = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        for (const run of yield* events.nextPendingRuns)
          if (!waiting(run, now)) yield* dispatchRun(run);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Event dispatch tick failed", cause),
        ),
      );

      return EventDispatcher.of({ tick, start: startTicking(tick, scope) });
    }),
  );
}
