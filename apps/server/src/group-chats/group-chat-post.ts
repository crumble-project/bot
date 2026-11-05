import { pi } from "../shared/app-errors";
import { Effect } from "effect";
import { appErrors } from "../shared/app-errors";
import type {
  AttachmentInfo,
  AttachmentInput,
} from "../shared/attachment-rules";
import { prepareAttachments } from "../shared/attachments";
import { InvalidInput, type AppError } from "../shared/errors";
import { logged, type GroupChatContext } from "./group-chat-context";
import type { GroupChatMembers } from "./group-chat-members";
import type { GroupMessageReceipt } from "./group-chat-types";
import type { GroupEntry } from "./group-transcripts";
import type { GroupTurnEngine } from "./group-turn-engine";
import { MESSAGE_PREVIEW_CHARS } from "../shared/limits";

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

export const groupChatPost = ({
  context,
  members,
  turns,
}: GroupChatPostDeps): GroupChatPost => {
  const writeOwnerMessage = Effect.fnUntraced(function* (
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

    const { entry, entryId, created } = yield* writeOwnerMessage(
      groupId,
      requestId,
      { content, attachments, info, target },
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
