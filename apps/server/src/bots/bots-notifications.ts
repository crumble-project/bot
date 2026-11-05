import { Effect } from "effect";
import type { JobAnswer } from "../jobs/jobs";
import { logged } from "../shared/app-errors";
import { activeExecution, type Execution } from "../shared/domain";
import { formatEntryId } from "../shared/entry-ids";
import { nowIso } from "../shared/time";
import type { Activity } from "./bots";
import type { BotsContext } from "./bots-context";

export type BotsNotifications = ReturnType<typeof botsNotifications>;

export const botsNotifications = (context: BotsContext) => {
  const { activityListeners, agents, executions, listeners, scope } = context;
  const { settledListeners } = context;

  const subscribe = (conversationId: string, callback: () => void) =>
    listeners.add(conversationId, callback);

  const onActivity = (callback: (event: Activity) => void) => {
    activityListeners.add(callback);

    return () => {
      activityListeners.delete(callback);
    };
  };

  const onSettled = (
    callback: (execution: Execution) => void | Promise<void>,
  ) => {
    settledListeners.add(callback);

    return () => {
      settledListeners.delete(callback);
    };
  };

  const changed = (conversationId: string) =>
    Effect.sync(() => listeners.notify(conversationId));

  const emit = (event: Activity) =>
    Effect.sync(() => {
      for (const listener of activityListeners) listener(event);
    });

  const settled = Effect.fnUntraced(function* (executionId: string) {
    const execution = yield* executions.get(executionId);

    if (!execution || activeExecution(execution)) return;

    for (const listener of settledListeners)
      yield* Effect.tryPromise(async () => listener(execution)).pipe(
        logged("Settled execution handler failed", executionId),
        Effect.forkIn(scope),
      );
  });

  const record = Effect.fnUntraced(function* (
    execution: Execution,
    patch: Pick<Execution, "status"> & Partial<Pick<Execution, "error">>,
  ) {
    const current = yield* executions.get(execution.id);

    if (!current || current.status === "cancelled" || current.status === "done")
      return false;

    yield* executions.update(execution.id, patch);

    return true;
  });

  const settle = Effect.fnUntraced(function* (
    execution: Execution,
    patch: Parameters<typeof record>[1],
  ) {
    if (!(yield* record(execution, patch))) return false;

    yield* changed(execution.conversationId);
    yield* settled(execution.id);

    return true;
  });

  const announceJobAnswer = Effect.fn("Bots.announceJobAnswer")(function* (
    answer: JobAnswer,
  ) {
    const owner = yield* agents.get(answer.agentId);

    // Bots of another server in the same process are not this account's.
    if (!owner) return;

    yield* emit({
      type: "reply",
      executionId: answer.eventId,
      agentId: owner.id,
      agentName: owner.name,
      entryId: formatEntryId(owner.id, Number(answer.entryId)),
      origin: answer.kind,
      jobName: answer.name,
      preview: answer.preview,
      createdAt: yield* nowIso,
    });
  });

  return {
    subscribe,
    onActivity,
    onSettled,
    changed,
    emit,
    settled,
    record,
    settle,
    announceJobAnswer,
  };
};
