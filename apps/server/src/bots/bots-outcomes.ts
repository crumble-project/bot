import { Effect, Predicate, Result } from "effect";
import type { Agent, Execution } from "../shared/domain";
import type { botsActivity } from "./bots-activity";
import type { botsAnnouncements } from "./bots-announcements";
import { background, isGroupTurn, type BotsContext } from "./bots-context";
import type { AgentRuntime } from "./runtime";

type SubmissionOutcome = Awaited<ReturnType<AgentRuntime["wait"]>>;

type OutcomeDeps = {
  notifications: ReturnType<typeof botsActivity>;
  announcements: ReturnType<typeof botsAnnouncements>;
};

const outcomeError = (result: SubmissionOutcome) =>
  result.status === "done"
    ? null
    : "detail" in result
      ? Predicate.isString(result.detail)
        ? result.detail
        : result.reason
      : "The agent could not answer this input";

/** Records what a submission's end did to its execution, and announces a finished reply. */
export const botsOutcomes = (context: BotsContext, deps: OutcomeDeps) => {
  const { executions, scope } = context;
  const { changed, settled } = deps.notifications;
  const { announceReply } = deps.announcements;

  const recordFailure = Effect.fnUntraced(function* (
    execution: Execution,
    cause: unknown,
  ) {
    if (yield* executions.get(execution.id))
      yield* executions.update(execution.id, {
        status: "failed",
        error: String(cause instanceof Error ? cause.message : cause),
      });
    yield* changed(execution.conversationId);
    yield* settled(execution.id);
  });

  const recordOutcome = Effect.fnUntraced(function* (
    execution: Execution,
    result: SubmissionOutcome,
  ) {
    const current = yield* executions.get(execution.id);

    if (!current || current.status === "cancelled")
      return yield* settled(execution.id);

    yield* executions.update(execution.id, {
      status: result.status === "done" ? "done" : "failed",
      error: outcomeError(result),
    });
    yield* changed(execution.conversationId);
    yield* settled(execution.id);

    if (result.status === "done" && !isGroupTurn(execution))
      yield* announceReply(execution).pipe(
        background("Reply announcement failed", execution.id),
        Effect.forkIn(scope),
      );
  });

  return { recordFailure, recordOutcome };
};

/** Waits for a submission's outcome and records it; closing the bots interrupts the wait, never the recording. */
export const botsMonitor = (
  context: BotsContext,
  outcomes: ReturnType<typeof botsOutcomes>,
) => {
  const { runtime } = context;
  const { recordFailure, recordOutcome } = outcomes;

  const monitor = Effect.fnUntraced(function* (
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

  return { monitor };
};
