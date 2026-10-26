import type { Bots } from "./bots";
import { botsActivity } from "./bots-activity";
import { botsAdmission } from "./bots-admission";
import { botsAnnouncements } from "./bots-announcements";
import { botsChat } from "./bots-chat";
import type { BotsContext } from "./bots-context";
import { botsLifecycle } from "./bots-lifecycle";
import { botsLookup } from "./bots-lookup";
import { botsMonitor, botsOutcomes } from "./bots-outcomes";
import { botsReads } from "./bots-reads";
import { botsSubmissions } from "./bots-submissions";

/** The bots' operations, each group built from the context of one layer build. */
const botsGroups = (context: BotsContext) => {
  const lookup = botsLookup(context);
  const activity = botsActivity(context);
  const reads = botsReads(context, lookup);

  const announcements = botsAnnouncements(context, {
    notifications: activity,
    reads,
  });

  const chat = botsChat(context, {
    lookup,
    reads,
    notifications: activity,
    announcements,
  });

  const outcomes = botsOutcomes(context, {
    notifications: activity,
    announcements,
  });

  const monitor = botsMonitor(context, outcomes);

  const admission = botsAdmission(context, {
    lookup,
    reads,
    notifications: activity,
    monitor: monitor.monitor,
  });

  const submissions = botsSubmissions(context, {
    lookup,
    chat: chat.chat,
    notifications: activity,
    announcements,
    admit: admission.admit,
  });

  const lifecycle = botsLifecycle(context, {
    lookup,
    chat: chat.chat,
    notifications: activity,
    admit: admission.admit,
  });

  return { lookup, activity, reads, chat, submissions, lifecycle };
};

/** The bots as the service interface offers them, over one layer build's context. */
export const botsService = (context: BotsContext): Bots["Service"] => {
  const { lookup, activity, reads, chat, submissions, lifecycle } =
    botsGroups(context);

  return {
    agent: lookup.agent,
    conversation: lookup.conversation,
    subscribe: activity.subscribe,
    onActivity: activity.onActivity,
    onSettled: activity.onSettled,
    agentPreviews: reads.agentPreviews,
    announceJobAnswer: activity.announceJobAnswer,
    announce: activity.announce,
    snapshot: reads.snapshot,
    chat: chat.chat,
    recordBotMessage: chat.recordBotMessage,
    chatSnapshot: chat.chatSnapshot,
    history: reads.history,
    codingJobs: reads.codingJobs,
    codingJobHistory: reads.codingJobHistory,
    desktopJobs: reads.desktopJobs,
    desktopJobHistory: reads.desktopJobHistory,
    sendChat: submissions.sendChat,
    notice: submissions.notice,
    send: submissions.send,
    dispatch: submissions.dispatch,
    recover: lifecycle.recover,
    compact: lifecycle.compact,
    abortChat: lifecycle.abortChat,
    abort: lifecycle.abort,
    deleteAgent: lifecycle.deleteAgent,
  };
};
