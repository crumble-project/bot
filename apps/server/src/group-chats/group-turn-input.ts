import { pi } from "../shared/app-errors";
import { Effect } from "effect";
import {
  MAX_ATTACHMENTS,
  attachmentKind,
  type AttachmentInput,
} from "../shared/attachment-rules";
import type { Agent } from "../contract/agents";
import type { GroupChat } from "./group-chat-repository";
import { replyText } from "../shared/reply-text";
import { type GroupChatContext } from "./group-chat-context";
import { senderLabel, type GroupEntry } from "./group-transcripts";

/** How long a joining member's summary may take before its turn starts without one. */
const SUMMARY_TIMEOUT_MS = 60_000;

/** Characters of earlier messages a joining member's summary is written from, newest first. */
const SUMMARY_INPUT_CHARACTERS = 40_000;

const SUMMARY_INSTRUCTIONS =
  "Summarize this group chat for a bot that is joining it, in under 200 words. Keep decisions, open questions, who asked whom for what, and facts the group relies on. Name senders. Write plain prose without a heading.";

/** A short summary of a group conversation, written by the bot's own model for its first turn after joining. */
async function writeSummary(
  context: GroupChatContext,
  agent: Agent,
  transcript: string,
  signal: AbortSignal,
) {
  const answer = await context.runtime.complete(
    agent,
    SUMMARY_INSTRUCTIONS,
    transcript,
    signal,
  );

  const summary = replyText(answer).trim();

  if (answer.stopReason === "error" || answer.stopReason === "aborted")
    throw new Error(answer.errorMessage ?? "The summary failed");

  if (!summary) throw new Error("The summary was empty");

  return summary;
}

/** What a turn tells its member: the earlier conversation, and the messages it answers. */
export const groupTurnInput = (context: GroupChatContext) => {
  /** The messages up to `cursor`, newest first until the summary budget, summarized by the joining bot's model. */
  const summarize = Effect.fnUntraced(function* (
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
      const line = `${senderLabel(entry.sender)}: ${entry.text}`;

      if (length + line.length > SUMMARY_INPUT_CHARACTERS) break;
      lines.unshift(line);
      length += line.length;
    }

    return yield* Effect.tryPromise({
      try: () =>
        writeSummary(
          context,
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

  /**
   * The uploads of a turn's unseen messages, newest messages first up to the attachment limit, in message order.
   * Images are left out, by name, for a model that cannot read them while the account has no vision model; with one,
   * they pass through and the vision model describes them for the bot.
   */
  const turnAttachments = Effect.fnUntraced(function* (
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
        else if (attachments.length < MAX_ATTACHMENTS)
          attachments.unshift(item);
      }

    return { attachments, omitted };
  });

  const turnInput = Effect.fnUntraced(function* (
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

      return `${senderLabel(entry.sender)}${reply}: ${entry.text}${files}`;
    });

    return `Group chat ${JSON.stringify(group.name)}. You are ${name}; the other members are the owner and ${members.join(", ") || "no other bots"}.\n\nNew messages:\n\n${messages.join("\n\n")}`;
  });

  return { summarize, turnAttachments, turnInput };
};

export type GroupTurnInput = ReturnType<typeof groupTurnInput>;
