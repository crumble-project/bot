import type { Bots } from "./bots";
import { botsAdmission } from "./bots-admission";
import { botsAnnouncements } from "./bots-announcements";
import { botsChat } from "./bots-chat";
import type { BotsContext } from "./bots-context";
import { botsLifecycle } from "./bots-lifecycle";
import { botsLookup } from "./bots-lookup";
import { botsNotifications } from "./bots-notifications";
import { botsMonitor } from "./bots-outcomes";
import { botsReads } from "./bots-reads";
import { botsSubmissions } from "./bots-submissions";

/** The bots as the service interface offers them, over one layer build's context. */
export const botsService = (context: BotsContext): Bots["Service"] => {
  const lookup = botsLookup(context);
  const notifications = botsNotifications(context);
  const reads = botsReads(context, lookup);

  const announcements = botsAnnouncements(context, {
    notifications,
    snapshot: reads.snapshot,
    origin: reads.origin,
  });

  const chat = botsChat(context, {
    lookup,
    snapshot: reads.snapshot,
    notifications,
    announcements,
  });

  const { admit } = botsAdmission(context, {
    lookup,
    origin: reads.origin,
    notifications,
    monitor: botsMonitor(context, { notifications, announcements }),
  });

  const submissions = botsSubmissions(context, {
    lookup,
    chat: chat.chat,
    notifications,
    announcements,
    admit,
  });

  const lifecycle = botsLifecycle(context, {
    lookup,
    chat: chat.chat,
    notifications,
    admit,
  });

  return {
    agent: lookup.agent,
    conversation: lookup.conversation,
    subscribe: notifications.subscribe,
    onActivity: notifications.onActivity,
    onSettled: notifications.onSettled,
    agentPreviews: reads.agentPreviews,
    announceJobAnswer: notifications.announceJobAnswer,
    announce: notifications.emit,
    snapshot: reads.snapshot,
    chat: chat.chat,
    recordBotMessage: chat.recordBotMessage,
    chatSnapshot: chat.chatSnapshot,
    history: reads.history,
    jobs: reads.jobs,
    jobHistory: reads.jobHistory,
    attachment: reads.attachment,
    watch: reads.watch,
    answerJob: submissions.answerJob,
    sendChat: submissions.sendChat,
    notice: submissions.notice,
    send: submissions.send,
    dispatch: submissions.dispatch,
    recover: lifecycle.recover,
    compact: lifecycle.compact,
    abortChat: lifecycle.abortChat,
    abort: lifecycle.abort,
    stopAgent: lifecycle.stopAgent,
    deleteAgent: lifecycle.deleteAgent,
  };
};
