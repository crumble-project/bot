import { Effect } from "effect";
import { appErrors } from "../shared/app-errors";
import {
  prepareAttachments,
  type AttachmentInfo,
  type AttachmentInput,
} from "../shared/attachments";
import { InvalidInput, type AppError } from "../shared/errors";
import { logged, pi, type GroupChatContext } from "./group-chat-context";
import type { GroupChatMembers } from "./group-chat-members";
import type { GroupMessageReceipt } from "./group-chat-types";
import type { GroupEntry } from "./group-transcripts";
import type { GroupTurnEngine } from "./group-turn-engine";

/** Owner messages a group remembers as awaiting their first answer; older ones stop notifying. */
const AWAITING_ANSWERS = 50;

export type GroupChatPostOptions = {
  replyTo?: string | undefined;
  attachments?: AttachmentInput[] | undefined;
};

export type GroupChatPost = (
  groupId: string,
  content: string,
  requestId: string,
  options?: GroupChatPostOptions,
) => Effect.Effect<GroupMessageReceipt, AppError>;

export type GroupChatPostDeps = {
  readonly context: GroupChatContext;
  readonly members: GroupChatMembers;
  readonly turns: GroupTurnEngine;
};

type OwnerMessage = {
  content: string;
  attachments: AttachmentInput[];
  info: AttachmentInfo[];
  target: GroupEntry | undefined;
};

/** Remembers this message as awaiting its first answer, forgetting the oldest ones, and re-arms bot turns. */
const rememberAwaitingAnswers = Effect.fnUntraced(function* (
  context: GroupChatContext,
  groupId: string,
  entryId: string,
  woken: string[],
) {
  const { awaitingAnswers } = yield* context.groups.activity(groupId);

  const entries = Object.keys(awaitingAnswers)
    .map(Number)
    .sort((a, b) => a - b);

  for (const entry of entries.slice(
    0,
    Math.max(0, entries.length - AWAITING_ANSWERS + 1),
  ))
    delete awaitingAnswers[entry];

  awaitingAnswers[entryId.slice(groupId.length + 1)] = yield* Effect.filter(
    woken,
    context.enabled,
  );
  yield* context.groups.setActivity(groupId, {
    botTurns: 0,
    paused: false,
    awaitingAnswers,
  });
});

/** Queues a turn for every woken member that has messages left and is not already running one. */
const queueWoken = Effect.fnUntraced(function* (
  context: GroupChatContext,
  members: GroupChatMembers,
  groupId: string,
  woken: string[],
  through: number,
  created: boolean,
) {
  for (const agentId of woken) {
    const member = yield* context.groups.member(groupId, agentId);
    const turn = yield* context.groups.activeTurn(groupId, agentId);

    if (
      member &&
      (yield* context.enabled(agentId)) &&
      member.cursor < through &&
      (created || !member.pending) &&
      (!turn || turn.through < through)
    )
      yield* members.queueMember(groupId, agentId, false);
  }
});

const startQueued = (
  deps: GroupChatPostDeps,
  groupId: string,
  woken: string[],
) =>
  Effect.gen(function* () {
    const { context, turns } = deps;

    for (const agentId of woken) {
      const member = yield* context.groups.member(groupId, agentId);

      if (
        member?.pending &&
        !(yield* context.groups.activeTurn(groupId, agentId))
      )
        yield* turns.wake(groupId, agentId, member.pendingBotStarted);
    }

    yield* context.changed(groupId);
  }).pipe(logged("Group turns could not start", groupId));

const writeOwnerMessage = Effect.fnUntraced(function* (
  context: GroupChatContext,
  groupId: string,
  requestId: string,
  message: OwnerMessage,
) {
  const { content, attachments, info, target } = message;

  return yield* pi(() =>
    context.transcripts.write(
      groupId,
      {
        text: content,
        sender: { kind: "owner" },
        ...(attachments.length && { attachments, files: info }),
        ...(target && {
          replyTo: target.entryId,
          replyPreview: target.text.slice(0, 240),
        }),
      },
      requestId,
    ),
  );
});

const post = Effect.fn("GroupChats.post")(function* (
  deps: GroupChatPostDeps,
  groupId: string,
  content: string,
  requestId: string,
  options: GroupChatPostOptions = {},
) {
  const { context, members } = deps;
  yield* context.get(groupId);
  const attachments = options.attachments ?? [];

  // Validate before anything is written, so a bad file never leaves a message behind.
  const { info } = yield* appErrors(
    Effect.try({
      try: () => prepareAttachments(attachments),
      catch: (error) => error,
    }),
  );

  const replyTo = options.replyTo;

  const target = replyTo
    ? yield* pi(() => context.transcripts.message(groupId, replyTo))
    : undefined;

  if (replyTo && !target)
    return yield* Effect.fail(
      new InvalidInput({
        message: "Reply to a message in this group chat",
      }),
    );

  const { entryId, created } = yield* writeOwnerMessage(
    context,
    groupId,
    requestId,
    { content, attachments, info, target },
  );

  const group = yield* context.get(groupId);
  const mentioned = yield* members.mentions(group, content, undefined, target);
  const woken = mentioned.length ? mentioned : group.memberIds;

  // A retried post routes again, but neither resumes the bots nor re-arms its notification.
  if (created) yield* rememberAwaitingAnswers(context, groupId, entryId, woken);

  const through = Number(entryId.slice(groupId.length + 1));

  yield* queueWoken(context, members, groupId, woken, through, created);
  yield* context.changed(groupId);

  context.state.fork(
    context.serial(groupId, startQueued(deps, groupId, woken)),
  );

  return { requestId, entryId };
});

export const groupChatPost =
  (deps: GroupChatPostDeps): GroupChatPost =>
  (groupId, content, requestId, options) =>
    post(deps, groupId, content, requestId, options);
