import { activeExecution } from "../shared/domain";
import { pi } from "../shared/app-errors";
import { Effect } from "effect";
import type { GroupChat } from "../shared/domain";
import { type GroupChatContext } from "./group-chat-context";
import { mentionedMembers } from "./group-mentions";
import type { GroupEntry } from "./group-transcripts";

/** How a group reaches its members: who a message wakes, who joins, and who is stopped. */
export const groupChatMembers = (context: GroupChatContext) => {
  const { agents, bots, conversations, executions, groups, runtime } = context;

  /** Members a message wakes: its mentions and, for a reply, the bot it answers. */
  const mentions = Effect.fnUntraced(function* (
    group: GroupChat,
    text: string,
    senderId: string | undefined,
    replyTarget?: GroupEntry,
  ) {
    const members = (yield* Effect.forEach(group.memberIds, (agentId) =>
      agents.get(agentId),
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

  const openConversation = Effect.fnUntraced(function* (
    group: GroupChat,
    agentId: string,
  ) {
    const agent = yield* bots.agent(agentId);
    // Opening the bot chat first keeps an upgraded bot's chat from adopting the group conversation as its session.
    yield* bots.chat(agentId);

    const conversationId = yield* pi(() =>
      runtime.openGroupConversation(agent, group.id),
    );

    yield* conversations.create({ agentId, title: group.name }, conversationId);
    yield* groups.setMember(group.id, agentId, { conversationId });

    return conversationId;
  });

  /** Stops the member's turn and drops its queued one; a stopped turn posts nothing. Reports whether there was any. */
  const abortTurn = Effect.fnUntraced(function* (
    groupId: string,
    agentId: string,
  ) {
    const member = yield* groups.member(groupId, agentId);
    const queued = member?.pending === true;

    if (queued) yield* groups.setMember(groupId, agentId, { pending: false });
    const turn = yield* groups.activeTurn(groupId, agentId);
    const execution = turn ? yield* executions.get(turn.executionId) : null;

    if (!execution || !activeExecution(execution)) return queued;
    yield* bots.abort(execution.conversationId);

    return true;
  });

  return { mentions, openConversation, abortTurn };
};

export type GroupChatMembers = ReturnType<typeof groupChatMembers>;
