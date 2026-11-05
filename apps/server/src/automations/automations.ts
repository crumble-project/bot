import { Context, Effect, Layer } from "effect";
import { EventRepository } from "../event-sources/event-repository";
import type { Agent } from "../contract/agents";
import type { Execution } from "../shared/domain";
import type { Schedule } from "../contract/schedules";
import { eventRequest, scheduleRequest } from "../shared/request-ids";
import { ScriptRuns } from "./script-runs";
import { AutomationDispatch } from "./automation-dispatch";

// A failed start waits this long before it is tried again.
export const RETRY_AFTER_MS = 30_000;

/** When each key's start last failed. Keys past their wait fall out on any check, so deleted ones leave too. */
export const retryLedger = () => {
  const failedAt = new Map<string, number>();

  return {
    failed: (key: string, at: number) => void failedAt.set(key, at),
    forget: (key: string) => void failedAt.delete(key),
    waiting: (key: string, now: number) => {
      for (const [each, at] of failedAt)
        if (now - at >= RETRY_AFTER_MS) failedAt.delete(each);

      return failedAt.has(key);
    },
  };
};

/** What starts an automation. A run by hand is an occurrence too, so an event automation started that way gets no event. */
export type AutomationTrigger =
  | { kind: "occurrence"; due: string }
  | { kind: "event"; eventId: string };

export type AutomationStarted = {
  admitted: boolean;
  result?: Pick<Execution, "id" | "status">;
};

/** Whether the automation may start; a run stored while it was on still waits for this. */
export const automationOn = (
  schedule: Schedule,
  agent: Agent | null | undefined,
) => schedule.enabled && agent?.enabled === true;

const requestOf = (schedule: Schedule, trigger: AutomationTrigger) =>
  trigger.kind === "event"
    ? eventRequest(trigger.eventId, schedule.id)
    : scheduleRequest(schedule.id, trigger.due);

/** Starts an automation: a prompt goes to its bot's chat, a script to its bot's workspace. */
export class Automations extends Context.Service<
  Automations,
  {
    /** Success means the work was durably admitted; not admitted while its last start is in flight or its script runs. */
    readonly start: (
      schedule: Schedule,
      trigger: AutomationTrigger,
    ) => Effect.Effect<AutomationStarted, unknown>;
  }
>()("crumble/automations/Automations") {
  static readonly layer = Layer.effect(
    Automations,
    Effect.gen(function* () {
      const events = yield* EventRepository;
      const dispatch = yield* AutomationDispatch;
      const scripts = yield* ScriptRuns;
      const inFlight = new Set<string>();

      const startScript = Effect.fnUntraced(function* (
        schedule: Schedule,
        trigger: AutomationTrigger,
      ): Effect.fn.Return<AutomationStarted, unknown> {
        const event =
          trigger.kind === "event"
            ? yield* events.eventWithSource(trigger.eventId)
            : undefined;

        if (event === null)
          return yield* Effect.fail(new Error("The event is gone"));

        const { admitted, run } = yield* scripts.start(schedule, event);

        return {
          admitted,
          ...(run && { result: { id: run.id, status: "running" as const } }),
        };
      });

      const startPrompt = Effect.fnUntraced(function* (
        schedule: Schedule,
        trigger: AutomationTrigger,
      ): Effect.fn.Return<AutomationStarted, unknown> {
        const result = yield* dispatch(
          schedule.agentId,
          schedule.prompt,
          requestOf(schedule, trigger),
          schedule.id,
        );

        return { admitted: true, result };
      });

      const start = Effect.fnUntraced(function* (
        schedule: Schedule,
        trigger: AutomationTrigger,
      ): Effect.fn.Return<AutomationStarted, unknown> {
        if (inFlight.has(schedule.id)) return { admitted: false };
        inFlight.add(schedule.id);

        return yield* (
          schedule.kind === "script"
            ? startScript(schedule, trigger)
            : startPrompt(schedule, trigger)
        ).pipe(
          Effect.ensuring(Effect.sync(() => inFlight.delete(schedule.id))),
        );
      });

      return Automations.of({ start });
    }),
  );
}
