import { Effect } from "effect";
import type { TranscriptPage } from "../bots/transcript";
import type { AttachmentInput } from "../shared/attachments";
import type { GroupChat, GroupChatInput } from "../shared/domain";
import { NotFound, type AppError } from "../shared/errors";
import { active, pi, type GroupChatContext } from "./group-chat-context";
import type { GroupChatMembers } from "./group-chat-members";
import { groupChatPost } from "./group-chat-post";
import type {
  GroupActivity,
  GroupAttachment,
  GroupChatSnapshot,
  GroupMemberActivity,
  GroupMembership,
  GroupMessageReceipt,
  PageOptions,
} from "./group-chat-types";
import type { GroupTurnEngine } from "./group-turn-engine";

/** Group chats between the owner and several bots: membership, the shared transcript, turns, and change notifications. */
export type GroupChatsService = {
  readonly list: Effect.Effect<GroupChat[]>;
  readonly get: (groupId: string) => Effect.Effect<GroupChat, AppError>;
  readonly create: (
    input: GroupChatInput,
  ) => Effect.Effect<GroupChat, AppError>;
  readonly update: (
    groupId: string,
    input: GroupChatInput,
  ) => Effect.Effect<GroupChat, AppError>;
  readonly delete: (groupId: string) => Effect.Effect<void, AppError>;
  readonly post: (
    groupId: string,
    content: string,
    requestId: string,
    options?: {
      replyTo?: string | undefined;
      attachments?: AttachmentInput[] | undefined;
    },
  ) => Effect.Effect<GroupMessageReceipt, AppError>;
  /** Ends every running turn in the group and drops the queued ones. */
  readonly stop: (groupId: string) => Effect.Effect<void, AppError>;
  readonly activity: (
    groupId: string,
  ) => Effect.Effect<GroupActivity, AppError>;
  readonly attachment: (
    groupId: string,
    entryId: string,
    index: number,
  ) => Effect.Effect<GroupAttachment, AppError>;
  /** The groups a bot belongs to, with their members' names and newest message time, for its lookup tool. */
  readonly forMember: (agentId: string) => Effect.Effect<GroupMembership[]>;
  /** A page of a group's transcript, for a bot that is one of its members. */
  readonly readAsMember: (
    agentId: string,
    groupId: string,
    options: PageOptions,
  ) => Effect.Effect<TranscriptPage, AppError>;
  readonly history: (
    groupId: string,
    options: PageOptions,
  ) => Effect.Effect<TranscriptPage, AppError>;
  readonly snapshot: (
    groupId: string,
    options: { limit?: number | undefined },
  ) => Effect.Effect<GroupChatSnapshot, AppError>;
  /** Calls `callback` when the group changes, until the returned function is called. */
  readonly subscribe: (groupId: string, callback: () => void) => () => void;
  /** Finishes turns a restart interrupted, then starts the turns that were waiting. Run after the bots recover. */
  readonly recover: Effect.Effect<void, AppError>;
};

const create = Effect.fn("GroupChats.create")(function* (
  context: GroupChatContext,
  input: GroupChatInput,
) {
  yield* context.checkMembers(input.memberIds);

  return yield* context.groups.create(input);
});

const update = Effect.fn("GroupChats.update")(function* (
  context: GroupChatContext,
  members: GroupChatMembers,
  groupId: string,
  input: GroupChatInput,
) {
  const current = yield* context.get(groupId);
  yield* context.checkMembers(input.memberIds);

  return yield* context.serial(
    groupId,
    Effect.gen(function* () {
      const latest = yield* pi(() => context.transcripts.latest(groupId));
      const group = (yield* context.groups.update(groupId, input))!;

      // A new member starts with the messages that follow its joining; its summary of earlier ones comes later.
      for (const agentId of input.memberIds)
        if (!current.memberIds.includes(agentId))
          yield* context.groups.setMember(groupId, agentId, { cursor: latest });

      for (const agentId of current.memberIds)
        if (!input.memberIds.includes(agentId))
          yield* members.abortTurn(groupId, agentId);
      yield* context.changed(groupId);

      return group;
    }),
  );
});

const remove = Effect.fn("GroupChats.delete")(function* (
  context: GroupChatContext,
  members: GroupChatMembers,
  groupId: string,
) {
  const group = yield* context.get(groupId);
  yield* stop(context, members, groupId);

  // Queued behind the stop and the settling of the turns it stopped, so no turn posts into a deleted group.
  yield* context.serial(
    groupId,
    Effect.gen(function* () {
      // Remove the transcript first: a failure then leaves a group with an empty transcript, not an orphaned file.
      yield* pi(() => context.transcripts.delete(groupId));

      for (const agentId of group.memberIds) {
        const conversationId = (yield* context.groups.member(groupId, agentId))
          ?.conversationId;

        if (conversationId)
          yield* context.conversations.setArchived(conversationId, true);
      }

      yield* context.groups.delete(groupId);
      yield* context.changed(groupId);
    }),
  );
});

const stop = Effect.fn("GroupChats.stop")(function* (
  context: GroupChatContext,
  members: GroupChatMembers,
  groupId: string,
) {
  const group = yield* context.get(groupId);

  yield* context.serial(
    groupId,
    Effect.gen(function* () {
      let stopped = false;

      for (const agentId of group.memberIds)
        stopped = (yield* members.abortTurn(groupId, agentId)) || stopped;

      if (stopped) yield* context.changed(groupId);
    }),
  );
});

const activity = Effect.fn("GroupChats.activity")(function* (
  context: GroupChatContext,
  groupId: string,
) {
  const group = yield* context.get(groupId);
  const { botTurns, paused } = yield* context.groups.activity(groupId);
  const turns = yield* context.groups.listTurns({ groupId });

  return {
    paused,
    botTurns,
    members: yield* Effect.forEach(
      group.memberIds,
      Effect.fnUntraced(function* (agentId) {
        const member = yield* context.groups.member(groupId, agentId);
        const latest = turns.findLast((turn) => turn.agentId === agentId);

        const execution = latest
          ? yield* context.executions.get(latest.executionId)
          : null;

        const status: GroupMemberActivity["status"] = !(yield* context.enabled(
          agentId,
        ))
          ? "disabled"
          : (yield* context.groups.activeTurn(groupId, agentId))
            ? "running"
            : member?.pending
              ? "queued"
              : "idle";

        return {
          agentId,
          status,
          error: execution?.status === "failed" ? execution.error : null,
        };
      }),
    ),
  };
});

const attachment = Effect.fn("GroupChats.attachment")(function* (
  context: GroupChatContext,
  groupId: string,
  entryId: string,
  index: number,
) {
  yield* context.get(groupId);

  return yield* pi(() =>
    context.transcripts.attachment(groupId, entryId, index),
  );
});

const forMember = Effect.fn("GroupChats.forMember")(function* (
  context: GroupChatContext,
  agentId: string,
) {
  return yield* Effect.forEach(
    (yield* context.groups.list).filter((group) =>
      group.memberIds.includes(agentId),
    ),
    Effect.fnUntraced(function* (group) {
      const [latest] = (yield* Effect.promise(() =>
        context.transcripts.history(group.id, { limit: 1 }),
      )).messages;

      const members = yield* Effect.forEach(group.memberIds, (id) =>
        context.agents
          .get(id)
          .pipe(Effect.map((agent) => agent?.name ?? "A deleted bot")),
      );

      return {
        id: group.id,
        name: group.name,
        members,
        latestAt: latest?.timestamp
          ? new Date(latest.timestamp).toISOString()
          : null,
      };
    }),
    { concurrency: "unbounded" },
  );
});

const readAsMember = Effect.fn("GroupChats.readAsMember")(function* (
  context: GroupChatContext,
  agentId: string,
  groupId: string,
  options: PageOptions,
) {
  const group = yield* context.groups.get(groupId);

  if (!group?.memberIds.includes(agentId))
    return yield* Effect.fail(
      new NotFound({ message: "Group chat not found" }),
    );

  return yield* pi(() => context.transcripts.history(groupId, options));
});

const history = Effect.fn("GroupChats.history")(function* (
  context: GroupChatContext,
  groupId: string,
  options: PageOptions,
) {
  yield* context.get(groupId);

  return yield* pi(() => context.transcripts.history(groupId, options));
});

const snapshot = Effect.fn("GroupChats.snapshot")(function* (
  context: GroupChatContext,
  groupId: string,
  options: { limit?: number | undefined },
) {
  const groupChat = yield* context.get(groupId);
  const page = yield* pi(() => context.transcripts.history(groupId, options));

  return {
    ...page,
    groupChat,
    activity: yield* activity(context, groupId),
    updatedAt: Date.now(),
  };
});

const subscribe = (
  context: GroupChatContext,
  groupId: string,
  callback: () => void,
) => {
  const { listeners } = context.state;
  const set = listeners.get(groupId) ?? new Set();
  set.add(callback);
  listeners.set(groupId, set);

  return () => {
    set.delete(callback);

    if (!set.size) listeners.delete(groupId);
  };
};

const recover = (
  context: GroupChatContext,
  engine: GroupTurnEngine,
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    for (const turn of yield* context.groups.listTurns({
      status: ["running", "posting"],
    })) {
      const execution = yield* context.executions.get(turn.executionId);

      if (execution && !active(execution)) yield* engine.settled(execution);
    }

    for (const group of yield* context.groups.list)
      yield* context.serial(
        group.id,
        Effect.gen(function* () {
          for (const agentId of group.memberIds) {
            const member = yield* context.groups.member(group.id, agentId);

            if (
              member?.pending &&
              !(yield* context.groups.activeTurn(group.id, agentId))
            )
              yield* engine.wake(group.id, agentId, member.pendingBotStarted);
          }
        }),
      );
  });

export const groupChatsService = (
  context: GroupChatContext,
  members: GroupChatMembers,
  engine: GroupTurnEngine,
): GroupChatsService => ({
  list: context.groups.list,
  get: context.get,
  create: (input) => create(context, input),
  update: (groupId, input) => update(context, members, groupId, input),
  delete: (groupId) => remove(context, members, groupId),
  post: groupChatPost({ context, members, turns: engine }),
  stop: (groupId) => stop(context, members, groupId),
  activity: (groupId) => activity(context, groupId),
  attachment: (groupId, entryId, index) =>
    attachment(context, groupId, entryId, index),
  forMember: (agentId) => forMember(context, agentId),
  readAsMember: (agentId, groupId, options) =>
    readAsMember(context, agentId, groupId, options),
  history: (groupId, options) => history(context, groupId, options),
  snapshot: (groupId, options) => snapshot(context, groupId, options),
  subscribe: (groupId, callback) => subscribe(context, groupId, callback),
  recover: recover(context, engine),
});
