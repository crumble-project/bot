import { errorText } from "../shared/errors";
import { Cause, Clock, Context, Effect, Layer } from "effect";
import { AgentRepository } from "../bot-store/agent-repository";
import { startTicking } from "../shared/ticker";
import { Automations, automationOn, retryLedger } from "./automations";
import { EventRunRepository, type EventRun } from "./event-run-repository";
import { ScheduleRepository } from "./schedule-repository";

export const EVENT_MAX_ATTEMPTS = 10;

/** Starts each automation's oldest pending event run, one run per automation at a time. */
export class EventDispatcher extends Context.Service<
  EventDispatcher,
  {
    readonly tick: Effect.Effect<void>;
    /** Ticks every second until the account closes. */
    readonly start: Effect.Effect<void>;
  }
>()("crumble/automations/EventDispatcher") {
  static readonly layer = Layer.effect(
    EventDispatcher,
    Effect.gen(function* () {
      const runs = yield* EventRunRepository;
      const schedules = yield* ScheduleRepository;
      const agents = yield* AgentRepository;
      const automations = yield* Automations;
      const scope = yield* Effect.scope;
      const retries = retryLedger();

      const failed = Effect.fnUntraced(function* (
        run: EventRun,
        cause: unknown,
      ) {
        const attempts = run.attempts + 1;
        const error = errorText(cause);

        yield* Effect.logError(`Event run failed (${run.id}): ${error}`);

        if (attempts >= EVENT_MAX_ATTEMPTS)
          return yield* runs.mark(run.id, {
            status: "failed",
            attempts,
            error,
          });

        retries.failed(run.id, yield* Clock.currentTimeMillis);
        yield* runs.mark(run.id, { status: "pending", attempts, error });
      });

      const dispatchRun = Effect.fnUntraced(function* (run: EventRun) {
        const schedule = yield* schedules.get(run.scheduleId);
        const agent = schedule && (yield* agents.get(schedule.agentId));

        if (!schedule || !automationOn(schedule, agent))
          return yield* runs.mark(run.id, {
            status: "failed",
            error: "The automation or its bot was turned off",
          });

        // A start not admitted, such as a script still running, leaves the run for the next tick.
        yield* automations
          .start(schedule, { kind: "event", eventId: run.eventId })
          .pipe(
            Effect.flatMap(({ admitted }) =>
              admitted
                ? runs.mark(run.id, { status: "dispatched" })
                : Effect.void,
            ),
            Effect.catchCause((cause) => failed(run, Cause.squash(cause))),
          );
      });

      const tick = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        for (const run of yield* runs.nextPending)
          if (!retries.waiting(run.id, now)) yield* dispatchRun(run);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Event dispatch tick failed", cause),
        ),
      );

      return EventDispatcher.of({ tick, start: startTicking(tick, scope) });
    }),
  );
}
