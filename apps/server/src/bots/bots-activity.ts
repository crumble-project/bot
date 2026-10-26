import { Effect } from "effect";
import type { JobAnswer } from "../jobs/jobs";
import { conversationReference, type Execution } from "../shared/domain";
import type { Activity } from "./bots";
import { active, type BotsContext } from "./bots-context";

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

    if (!execution || active(execution)) return;

    for (const listener of settledListeners)
      void Promise.resolve(listener(execution)).catch((error) =>
        console.error("Settled execution handler failed", executionId, error),
      );
  });

  return { changed, emit, settled };
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
      entryId: conversationReference(owner.id, Number(answer.entryId)),
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
  };
};
