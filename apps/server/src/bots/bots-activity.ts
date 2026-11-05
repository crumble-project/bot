import { Effect } from "effect";
import type { JobAnswer } from "../jobs/jobs";
import { activeExecution, type Execution } from "../shared/domain";
import { formatEntryId } from "../shared/entry-ids";
import type { Activity } from "./bots";
import type { BotsContext } from "./bots-context";

/** The callbacks code outside the bots registers to hear about a chat, an activity, or a settled execution. */
export const botsSubscribers = (context: BotsContext) => {
  const { listeners, activityListeners, settledListeners } = context;

  const subscribe = (conversationId: string, callback: () => void) => {
    const set = listeners.get(conversationId) ?? new Set();
    set.add(callback);
    listeners.set(conversationId, set);

    return () => {
      set.delete(callback);

      if (!set.size) listeners.delete(conversationId);
    };
  };

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

  return { subscribe, onActivity, onSettled };
};

/** Tells the registered listeners what changed: one chat, one activity, one settled execution. */
export const botsNotifications = (context: BotsContext) => {
  const { activityListeners, executions, listeners, settledListeners } =
    context;

  const changed = (conversationId: string) =>
    Effect.sync(() => {
      for (const listener of listeners.get(conversationId) ?? []) listener();
    });

  const emit = (event: Activity) =>
    Effect.sync(() => {
      for (const listener of activityListeners) listener(event);
    });

  const settled = Effect.fnUntraced(function* (executionId: string) {
    const execution = yield* executions.get(executionId);

    if (!execution || activeExecution(execution)) return;

    for (const listener of settledListeners)
      void Promise.resolve(listener(execution)).catch((error) =>
        console.error("Settled execution handler failed", executionId, error),
      );
  });

  // A cancel or a finished answer is final; a deleted execution has nothing to record.
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

  /** Ends an execution: records how, then tells its chat and the settled listeners. False when it was already over. */
  const settle = Effect.fnUntraced(function* (
    execution: Execution,
    patch: Parameters<typeof record>[1],
  ) {
    if (!(yield* record(execution, patch))) return false;

    yield* changed(execution.conversationId);
    yield* settled(execution.id);

    return true;
  });

  return { changed, emit, settled, record, settle };
};

/**
 * Tells activity listeners about the bot's answer to a job's report, such as a desktop job asking for the owner.
 * Job reports reach the chat without an execution, so a finished execution never announces them.
 */
export const botsJobAnswers = (
  context: BotsContext,
  notifications: ReturnType<typeof botsNotifications>,
) => {
  const { agents } = context;
  const { emit } = notifications;

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
      createdAt: new Date().toISOString(),
    });
  });

  return { announce: emit, announceJobAnswer };
};

/** Everything the bots tell their listeners: subscriptions, notifications, and job answers. */
export const botsActivity = (context: BotsContext) => {
  const notifications = botsNotifications(context);

  return {
    ...botsSubscribers(context),
    ...botsJobAnswers(context, notifications),
    changed: notifications.changed,
    emit: notifications.emit,
    settled: notifications.settled,
    record: notifications.record,
    settle: notifications.settle,
  };
};
