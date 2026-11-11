import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryId } from "@earendil-works/pi-durable";
import { noticeRequest } from "../shared/request-ids";
import { errorText } from "../shared/errors";
import { logged } from "../shared/app-errors";
import { Effect, Predicate, Result } from "effect";
import type { Agent } from "../contract/agents";
import type { Execution } from "../shared/domain";
import type { BotsAnnouncements } from "./bots-announcements";
import { isChatTurn, type BotsContext } from "./bots-context";
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

export const botsMonitor = (context: BotsContext, deps: MonitorDeps) => {
  const { runtime, scope, notices } = context;
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

    if (recorded && result.status === "done" && isChatTurn(execution))
      yield* announceReply(execution).pipe(
        logged("Reply announcement failed", execution.id),
        Effect.forkIn(scope),
      );
  });

  const upgradeNotice = Effect.fnUntraced(function* (
    execution: Execution,
    submissionId: string,
    owner: Agent,
  ) {
    const turn = yield* Effect.promise(() =>
      runtime.settledTurn(owner, execution.conversationId, submissionId),
    );

    if (!turn) return;

    // SAFETY: settledTurn returns the durable input entry ID supplied by Pi.
    const page = yield* Effect.promise(() =>
      turn.conversation.entries(
        { order: "ascending", minEntryId: turn.entry as EntryId },
        1,
        undefined,
        BACKGROUND_CONTEXT,
      ),
    );

    const input = page.items[0];

    if (!input || Number(input.id) !== turn.entry) return;

    if (
      Predicate.hasProperty(input.data, "attachments") &&
      Array.isArray(input.data.attachments) &&
      input.data.attachments.length
    )
      return;
    yield* notices.notice(
      execution.agentId,
      "Files sent just before the update didn't arrive. Send them again.",
      noticeRequest("files", "upgrade", execution.id),
    );
  });

  return Effect.fnUntraced(function* (
    execution: Execution,
    submissionId: string,
    owner: Agent,
    legacy = false,
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

    if (legacy && Result.isSuccess(outcome))
      yield* upgradeNotice(execution, submissionId, owner).pipe(
        logged("File upgrade notice failed", execution.id),
      );
  });
};
