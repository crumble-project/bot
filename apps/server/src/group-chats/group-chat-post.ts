import { logged, pi } from "../shared/app-errors";
import { Effect } from "effect";
import type { MessageFile } from "../files/message-files";
import { InvalidInput, type AppError } from "../shared/errors";
import type { GroupChatContext } from "./group-chat-context";
import type { GroupChatMembers } from "./group-chat-members";
import type { GroupMessageReceipt } from "./group-chat-types";
import type { GroupEntry } from "./group-transcripts";
import type { GroupTurnEngine } from "./group-turn-engine";
import { MESSAGE_PREVIEW_CHARS } from "../shared/limits";

export type GroupChatPostOptions = {
  replyTo?: string | undefined;
  files?: string[] | undefined;
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

type OwnerPost = {
  content: string;
  files: MessageFile[];
  target: GroupEntry | undefined;
};

export const groupChatPost = ({
  context,
  members,
  turns,
}: GroupChatPostDeps): GroupChatPost => {
  const writeOwnerMessage = Effect.fnUntraced(function* (
    groupId: string,
    requestId: string,
    message: OwnerPost,
  ) {
    const { content, files, target } = message;

    return yield* pi(() =>
      context.transcripts.write(
        groupId,
        {
          text: content,
          sender: { kind: "owner" },
          ...(files.length && { files }),
          ...(target && {
            replyTo: target.entryId,
            replyPreview: target.text.slice(0, MESSAGE_PREVIEW_CHARS),
          }),
        },
        requestId,
      ),
    );
  });

  return Effect.fn("GroupChats.post")(function* (
    groupId: string,
    content: string,
    requestId: string,
    options: GroupChatPostOptions = {},
  ) {
    yield* context.get(groupId);

    const ids = options.files ?? [];
    const ref = { kind: "group" as const, groupId };

    const previous = yield* pi(() =>
      context.transcripts.byRequest(groupId, requestId),
    );

    if (!previous && ids.length) yield* context.library.validate(ref, ids);

    const entries = yield* context.library.entries(ref, ids);

    const files: MessageFile[] = ids.map((id) => {
      const old = previous?.files?.find((file) => file.id === id);

      if (old) return old;

      const entry = entries.get(id);

      return entry
        ? { id, name: entry.name, mimeType: entry.mimeType, size: entry.size }
        : { id, deleted: true };
    });

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

    const { entry, entryId, created } = yield* writeOwnerMessage(
      groupId,
      requestId,
      { content, files, target },
    );

    const group = yield* context.get(groupId);

    const mentioned = yield* members.mentions(
      group,
      content,
      undefined,
      target,
    );

    const woken = mentioned.length ? mentioned : group.memberIds;

    yield* turns.queue(groupId, { entry, woken, created });
    yield* context.changed(groupId);

    context.state.fork(
      turns
        .startQueued(groupId, woken)
        .pipe(logged("Group turns could not start", groupId)),
    );

    return { requestId, entryId };
  });
};
