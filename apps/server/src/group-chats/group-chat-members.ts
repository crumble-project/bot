import { activeExecution } from "../shared/domain";
import { pi } from "../shared/app-errors";
import { Effect } from "effect";
import type { GroupChat } from "./group-chat-repository";
import { type GroupChatContext } from "./group-chat-context";
import { mentionedMembers } from "./group-mentions";
import { openGroupConversation } from "./group-turns";
import type { GroupEntry } from "./group-transcripts";

export const groupChatMembers = (context: GroupChatContext) => {
  const { agents, bots, conversations, executions, groups, runtime } = context;

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
    yield* bots.chat(agentId);

    const conversationId = yield* pi(() =>
      openGroupConversation(runtime, agent, group.id),
    );

    yield* conversations.create({ agentId, title: group.name }, conversationId);
    yield* groups.setMember(group.id, agentId, { conversationId });

    return conversationId;
  });

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
