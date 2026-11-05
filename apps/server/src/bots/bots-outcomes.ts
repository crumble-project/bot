import { errorText } from "../shared/errors";
import { logged } from "../shared/app-errors";
import { Effect, Predicate, Result } from "effect";
import type { Agent } from "../contract/agents";
import type { Execution } from "../shared/domain";
import type { BotsAnnouncements } from "./bots-announcements";
import { isGroupTurn, type BotsContext } from "./bots-context";
import type { BotsNotifications } from "./bots-notifications";
import type { AgentRuntime } from "./runtime";

type SubmissionOutcome = Awaited<ReturnType<AgentRuntime["wait"]>>;

type MonitorDeps = {
  notifications: BotsNotifications;
  announcements: BotsAnnouncements;
};

const outcomeError = (result: SubmissionOutcome) =>
  result.status === "done"
    ? null
    : "detail" in result
      ? Predicate.isString(result.detail)
        ? result.detail
        : result.reason
      : "The agent could not answer this input";

/** Waits for a submission's outcome, records it, and announces a finished reply. Closing the bots interrupts only the wait. */
export const botsMonitor = (context: BotsContext, deps: MonitorDeps) => {
  const { runtime, scope } = context;
  const { settle } = deps.notifications;
  const { announceReply } = deps.announcements;

  const recordFailure = (execution: Execution, cause: unknown) =>
    settle(execution, { status: "failed", error: errorText(cause) });

  const recordOutcome = Effect.fnUntraced(function* (
    execution: Execution,
    result: SubmissionOutcome,
  ) {
    const recorded = yield* settle(execution, {
      status: result.status === "done" ? "done" : "failed",
      error: outcomeError(result),
    });

    if (recorded && result.status === "done" && !isGroupTurn(execution))
      yield* announceReply(execution).pipe(
        logged("Reply announcement failed", execution.id),
        Effect.forkIn(scope),
      );
  });

  return Effect.fnUntraced(function* (
    execution: Execution,
    submissionId: string,
    owner: Agent,
  ) {
    const outcome = yield* Effect.result(
      Effect.tryPromise({
        try: () => runtime.wait(submissionId, owner),
        catch: (error) => error,
      }),
    );

    yield* Effect.uninterruptible(
      Result.isFailure(outcome)
        ? recordFailure(execution, outcome.failure)
        : recordOutcome(execution, outcome.success),
    );
  });
};
