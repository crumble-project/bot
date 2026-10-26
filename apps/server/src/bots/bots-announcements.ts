import { Effect } from "effect";
import type { Execution } from "../shared/domain";
import type { botsActivity } from "./bots-activity";
import { background, type BotsContext } from "./bots-context";
import type { botsReads } from "./bots-reads";
import { latestMessagePreview, latestReply } from "./transcript";

type AnnouncementDeps = {
  notifications: ReturnType<typeof botsActivity>;
  reads: ReturnType<typeof botsReads>;
};

/** Tells activity listeners which bot answered and how its reply begins. */
const botsPreviews = (context: BotsContext, deps: AnnouncementDeps) => {
  const { agents, activityListeners, scope } = context;
  const { emit } = deps.notifications;
  const { snapshot } = deps.reads;

  const announcePreview = Effect.fnUntraced(function* (
    agentId: string,
    conversationId: string,
  ) {
    if (!activityListeners.size) return;
    const owner = yield* agents.get(agentId);

    if (!owner) return;
    const { messages } = yield* snapshot(conversationId, {});

    yield* emit({
      type: "chat-preview",
      agentId: owner.id,
      agentName: owner.name,
      lastMessage: latestMessagePreview(messages),
    });
  });

  const forkPreview = (
    agentId: string,
    conversationId: string,
    subject: string,
  ) =>
    announcePreview(agentId, conversationId).pipe(
      background("Chat preview announcement failed", subject),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  return { announcePreview, forkPreview };
};

/** Tells activity listeners about a finished reply, unless the bot only reacted to the input. */
const botsReplies = (context: BotsContext, deps: AnnouncementDeps) => {
  const { agents, activityListeners } = context;
  const { emit } = deps.notifications;
  const { origin, snapshot } = deps.reads;

  const announceReply = Effect.fnUntraced(function* (execution: Execution) {
    if (!activityListeners.size) return;
    const owner = yield* agents.get(execution.agentId);

    if (!owner) return;
    const { messages } = yield* snapshot(execution.conversationId, {});

    yield* emit({
      type: "chat-preview",
      agentId: owner.id,
      agentName: owner.name,
      lastMessage: latestMessagePreview(messages),
    });

    const { reply, reaction } = latestReply(messages);

    // A reaction acknowledges the input without an answer worth a notification.
    if (!reply && reaction) return;

    yield* emit({
      type: "reply",
      executionId: execution.id,
      agentId: owner.id,
      agentName: owner.name,
      entryId: reply?.entryId ?? null,
      origin: (yield* origin(execution)).kind,
      preview: reply?.content.trim().slice(0, 240) ?? "",
      createdAt: execution.createdAt,
    });
  });

  return { announceReply };
};

/** What a bot's chat tells clients about as it changes: its newest message and its finished replies. */
export const botsAnnouncements = (
  context: BotsContext,
  deps: AnnouncementDeps,
) => ({
  ...botsPreviews(context, deps),
  ...botsReplies(context, deps),
});
