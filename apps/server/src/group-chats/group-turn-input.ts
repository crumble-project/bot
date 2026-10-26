import { Effect } from "effect";
import {
  MAX_ATTACHMENTS,
  attachmentKind,
  type AttachmentInput,
} from "../shared/attachments";
import type { Agent, GroupChat } from "../shared/domain";
import type { AppError } from "../shared/errors";
import { pi, type GroupChatContext } from "./group-chat-context";
import type { GroupEntry } from "./group-transcripts";

/** How long a joining member's summary may take before its turn starts without one. */
const SUMMARY_TIMEOUT_MS = 60_000;

/** Characters of earlier messages a joining member's summary is written from, newest first. */
const SUMMARY_INPUT_CHARACTERS = 40_000;

const senderName = (entry: GroupEntry) =>
  entry.sender.kind === "owner" ? "Owner" : (entry.sender.name ?? "A bot");

/** What a turn tells its member: the earlier conversation, and the messages it answers. */
export type GroupTurnInput = {
  /** The messages up to `cursor`, newest first until the summary budget, summarized by the joining bot's model. */
  readonly summarize: (
    groupId: string,
    agent: Agent,
    cursor: number,
  ) => Effect.Effect<string, AppError>;
  /**
   * The uploads of a turn's unseen messages, newest messages first up to the attachment limit, in message order.
   * Images are left out, by name, for a model that cannot read them.
   */
  readonly turnAttachments: (
    agent: Agent,
    unseen: GroupEntry[],
  ) => Effect.Effect<
    { attachments: AttachmentInput[]; omitted: string[] },
    AppError
  >;
  readonly turnInput: (
    group: GroupChat,
    name: string,
    unseen: GroupEntry[],
  ) => Effect.Effect<string>;
};

const summarize = Effect.fnUntraced(function* (
  context: GroupChatContext,
  groupId: string,
  agent: Agent,
  cursor: number,
) {
  const earlier = (yield* pi(() =>
    context.transcripts.after(groupId, 0),
  )).filter((entry) => entry.entry <= cursor && entry.reaction === undefined);

  const lines: string[] = [];
  let length = 0;

  for (const entry of earlier.toReversed()) {
    const line = `${senderName(entry)}: ${entry.text}`;

    if (length + line.length > SUMMARY_INPUT_CHARACTERS) break;
    lines.unshift(line);
    length += line.length;
  }

  return yield* Effect.tryPromise({
    try: () =>
      context.runtime.summarize(
        agent,
        lines.join("\n\n"),
        AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      ),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("Group summary failed", groupId, agent.id, error).pipe(
        Effect.as("The earlier conversation could not be summarized."),
      ),
    ),
  );
});

const turnAttachments = Effect.fnUntraced(function* (
  context: GroupChatContext,
  agent: Agent,
  unseen: GroupEntry[],
) {
  const images = yield* pi(() => context.runtime.acceptsImages(agent));
  const attachments: AttachmentInput[] = [];
  const omitted: string[] = [];

  for (const entry of unseen.toReversed())
    for (const item of (entry.attachments ?? []).toReversed()) {
      if (!images && attachmentKind(item.mimeType) === "image")
        omitted.unshift(item.name);
      else if (attachments.length < MAX_ATTACHMENTS) attachments.unshift(item);
    }

  return { attachments, omitted };
});

const turnInput = Effect.fnUntraced(function* (
  context: GroupChatContext,
  group: GroupChat,
  name: string,
  unseen: GroupEntry[],
) {
  const members = (yield* Effect.forEach(group.memberIds, (agentId) =>
    context.agents.get(agentId),
  ))
    .map((agent) => agent?.name)
    .filter((member) => member !== undefined && member !== name);

  const messages = unseen.map((entry) => {
    const reply =
      entry.replyPreview === undefined
        ? ""
        : ` (replying to "${entry.replyPreview.slice(0, 120)}")`;

    const files = entry.files?.length
      ? ` [attached: ${entry.files.map((file) => file.name).join(", ")}]`
      : "";

    return `${senderName(entry)}${reply}: ${entry.text}${files}`;
  });

  return `Group chat ${JSON.stringify(group.name)}. You are ${name}; the other members are the owner and ${members.join(", ") || "no other bots"}.\n\nNew messages:\n\n${messages.join("\n\n")}`;
});

export const groupTurnInput = (context: GroupChatContext): GroupTurnInput => ({
  summarize: (groupId, agent, cursor) =>
    summarize(context, groupId, agent, cursor),
  turnAttachments: (agent, unseen) => turnAttachments(context, agent, unseen),
  turnInput: (group, name, unseen) => turnInput(context, group, name, unseen),
});
