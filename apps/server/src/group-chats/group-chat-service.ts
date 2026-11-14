import { activeExecution } from "../shared/domain";
import { pi } from "../shared/app-errors";
import { Effect } from "effect";
import type { GroupChatInput } from "./group-chat-repository";
import { NotFound, type AppError } from "../shared/errors";
import { type GroupChatContext } from "./group-chat-context";
import type { GroupChatMembers } from "./group-chat-members";
import { groupChatPost } from "./group-chat-post";
import type { PageOptions, TranscriptPage } from "../transcript/transcript";
import type { GroupMemberActivity } from "./group-chat-types";
import type { GroupTurnEngine } from "./group-turn-engine";

export const groupChatsService = (
  context: GroupChatContext,
  members: GroupChatMembers,
  engine: GroupTurnEngine,
) => {
  const create = Effect.fn("GroupChats.create")(function* (
    input: GroupChatInput,
  ) {
    yield* context.checkMembers(input.memberIds);

    return yield* context.groups.create(input);
  });

  const update = Effect.fn("GroupChats.update")(function* (
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

        for (const agentId of input.memberIds)
          if (!current.memberIds.includes(agentId))
            yield* context.groups.setMember(groupId, agentId, {
              cursor: latest,
            });

        for (const agentId of current.memberIds)
          if (!input.memberIds.includes(agentId))
            yield* members.abortTurn(groupId, agentId);
        yield* context.changed(groupId);

        return group;
      }),
    );
  });

  const remove = Effect.fn("GroupChats.delete")(function* (groupId: string) {
    const group = yield* context.get(groupId);
    yield* stop(groupId);

    // Queued behind the stop and the settling of the turns it stopped, so no turn posts into a deleted group.
    yield* context.serial(
      groupId,
      Effect.gen(function* () {
        // Remove the transcript first: a failure then leaves a group with an empty transcript, not an orphaned file.
        yield* pi(() => context.transcripts.delete(groupId));

        for (const agentId of group.memberIds) {
          const conversationId = (yield* context.groups.member(
            groupId,
            agentId,
          ))?.conversationId;

          if (conversationId)
            yield* context.conversations.setArchived(conversationId, true);
        }

        yield* context.library.removeLibrary(
          { kind: "group", groupId },
          context.groups.delete(groupId),
        );
        yield* context.attention.removeChat({ kind: "group", id: groupId });
        yield* context.changed(groupId);
      }),
    );
  });

  const stop = Effect.fn("GroupChats.stop")(function* (groupId: string) {
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

          const statusOf = Effect.fnUntraced(function* () {
            if (!(yield* context.enabled(agentId))) return "disabled" as const;

            if (yield* context.groups.activeTurn(groupId, agentId))
              return "running" as const;

            return member?.pending ? ("queued" as const) : ("idle" as const);
          });

          const status: GroupMemberActivity["status"] = yield* statusOf();

          return {
            agentId,
            status,
            error: execution?.status === "failed" ? execution.error : null,
          };
        }),
      ),
    };
  });

  const currentFiles = Effect.fnUntraced(function* (
    groupId: string,
    page: TranscriptPage,
  ) {
    const ids = page.messages.flatMap((message) =>
      (message.files ?? []).map((file) => file.id),
    );

    const entries = yield* context.library.entries(
      { kind: "group", groupId },
      ids,
    );

    return {
      ...page,
      messages: page.messages.map((message) =>
        message.files
          ? {
              ...message,
              files: message.files.map((file) =>
                "deleted" in file || entries.has(file.id)
                  ? file
                  : { id: file.id, deleted: true as const },
              ),
            }
          : message,
      ),
    };
  });

  const forMember = Effect.fn("GroupChats.forMember")(function* (
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
    agentId: string,
    groupId: string,
    options: PageOptions,
  ) {
    const group = yield* context.groups.get(groupId);

    if (!group?.memberIds.includes(agentId))
      return yield* Effect.fail(
        new NotFound({ message: "Group chat not found" }),
      );

    return yield* currentFiles(
      groupId,
      yield* pi(() => context.transcripts.history(groupId, options)),
    );
  });

  const history = Effect.fn("GroupChats.history")(function* (
    groupId: string,
    options: PageOptions,
  ) {
    yield* context.get(groupId);

    return yield* currentFiles(
      groupId,
      yield* pi(() => context.transcripts.history(groupId, options)),
    );
  });

  const snapshot = Effect.fn("GroupChats.snapshot")(function* (
    groupId: string,
    options: { limit?: number | undefined },
  ) {
    const groupChat = yield* context.get(groupId);

    const page = yield* currentFiles(
      groupId,
      yield* pi(() => context.transcripts.history(groupId, options)),
    );

    return {
      ...page,
      groupChat,
      activity: yield* activity(groupId),
      updatedAt: Date.now(),
    };
  });

  const subscribe = (groupId: string, callback: () => void) =>
    context.state.listeners.add(groupId, callback);

  /** Finishes turns a restart interrupted, then starts the turns that were waiting. Run after the bots recover. */
  const recover: Effect.Effect<void, AppError> = Effect.gen(function* () {
    for (const turn of yield* context.groups.listTurns({
      status: ["running", "posting"],
    })) {
      const execution = yield* context.executions.get(turn.executionId);

      if (execution && !activeExecution(execution))
        yield* engine.settled(execution);
    }

    for (const group of yield* context.groups.list)
      yield* engine.startQueued(group.id, group.memberIds);
  });

  return {
    list: context.groups.list,
    get: context.get,
    create,
    update,
    delete: remove,
    post: groupChatPost({ context, members, turns: engine }),
    stop,
    activity,
    forMember,
    readAsMember,
    history,
    snapshot,
    subscribe,
    recover,
  };
};

export type GroupChatsService = ReturnType<typeof groupChatsService>;
