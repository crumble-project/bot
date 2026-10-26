import { Effect } from "effect";
import type { GroupChat } from "../shared/domain";
import type { AppError } from "../shared/errors";
import { active, pi, type GroupChatContext } from "./group-chat-context";
import { mentionedMembers } from "./group-mentions";
import type { GroupEntry } from "./group-transcripts";

/** How a group reaches its members: who a message wakes, who waits, who joins, and who is stopped. */
export type GroupChatMembers = {
  /** Members a message wakes: its mentions and, for a reply, the bot it answers. */
  readonly mentions: (
    group: GroupChat,
    text: string,
    senderId: string | undefined,
    replyTarget?: GroupEntry,
  ) => Effect.Effect<string[]>;
  readonly queueMember: (
    groupId: string,
    agentId: string,
    botStarted: boolean,
  ) => Effect.Effect<void>;
  readonly openConversation: (
    group: GroupChat,
    agentId: string,
  ) => Effect.Effect<string, AppError>;
  /** Stops the member's turn and drops its queued one; a stopped turn posts nothing. Reports whether there was any. */
  readonly abortTurn: (
    groupId: string,
    agentId: string,
  ) => Effect.Effect<boolean, AppError>;
};

const mentions = Effect.fnUntraced(function* (
  context: GroupChatContext,
  group: GroupChat,
  text: string,
  senderId: string | undefined,
  replyTarget?: GroupEntry,
) {
  const members = (yield* Effect.forEach(group.memberIds, (agentId) =>
    context.agents.get(agentId),
  )).flatMap((agent) => (agent ? [{ id: agent.id, name: agent.name }] : []));

  const found = mentionedMembers(text, members, senderId);
  const repliedTo = replyTarget?.sender.agentId;

  if (
    repliedTo &&
    repliedTo !== senderId &&
    group.memberIds.includes(repliedTo) &&
    !found.includes(repliedTo)
  )
    found.unshift(repliedTo);

  return found;
});

const queueMember = Effect.fnUntraced(function* (
  context: GroupChatContext,
  groupId: string,
  agentId: string,
  botStarted: boolean,
) {
  const member = yield* context.groups.member(groupId, agentId);

  if (!member) return;
  context.state.pendingVersions.set(`${groupId}:${agentId}`, Symbol());
  yield* context.groups.setMember(groupId, agentId, {
    pending: true,
    pendingBotStarted: member.pending
      ? member.pendingBotStarted && botStarted
      : botStarted,
  });
});

const openConversation = Effect.fnUntraced(function* (
  context: GroupChatContext,
  group: GroupChat,
  agentId: string,
) {
  const agent = yield* context.bots.agent(agentId);
  // Opening the bot chat first keeps an upgraded bot's chat from adopting the group conversation as its session.
  yield* context.bots.chat(agentId);

  const conversationId = yield* pi(() =>
    context.runtime.openGroupConversation(agent, group.id),
  );

  yield* context.conversations.create(
    { agentId, title: group.name },
    conversationId,
  );
  yield* context.groups.setMember(group.id, agentId, { conversationId });

  return conversationId;
});

const abortTurn = Effect.fnUntraced(function* (
  context: GroupChatContext,
  groupId: string,
  agentId: string,
) {
  const member = yield* context.groups.member(groupId, agentId);
  const queued = member?.pending === true;

  if (queued)
    yield* context.groups.setMember(groupId, agentId, { pending: false });
  const turn = yield* context.groups.activeTurn(groupId, agentId);

  const execution = turn
    ? yield* context.executions.get(turn.executionId)
    : null;

  if (!execution || !active(execution)) return queued;
  yield* context.bots.abort(execution.conversationId);

  return true;
});

export const groupChatMembers = (
  context: GroupChatContext,
): GroupChatMembers => ({
  mentions: (group, text, senderId, replyTarget) =>
    mentions(context, group, text, senderId, replyTarget),
  queueMember: (groupId, agentId, botStarted) =>
    queueMember(context, groupId, agentId, botStarted),
  openConversation: (group, agentId) =>
    openConversation(context, group, agentId),
  abortTurn: (groupId, agentId) => abortTurn(context, groupId, agentId),
});
