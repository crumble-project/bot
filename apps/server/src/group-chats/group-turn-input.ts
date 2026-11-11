import { pi } from "../shared/app-errors";
import { Effect } from "effect";
import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  attachmentKind,
} from "../shared/attachment-rules";
import type { Agent } from "../contract/agents";
import type { GroupChat } from "./group-chat-repository";
import { replyText } from "../shared/reply-text";
import { type GroupChatContext } from "./group-chat-context";
import { senderLabel, type GroupEntry } from "./group-transcripts";

const SUMMARY_TIMEOUT_MS = 60_000;

const SUMMARY_INPUT_CHARACTERS = 40_000;

const SUMMARY_INSTRUCTIONS =
  "Summarize this group chat for a bot that is joining it, in under 200 words. Keep decisions, open questions, who asked whom for what, and facts the group relies on. Name senders. Write plain prose without a heading.";

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

export const groupTurnInput = (context: GroupChatContext) => {
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

  const turnAttachments = Effect.fnUntraced(function* (
    groupId: string,
    agent: Agent,
    unseen: GroupEntry[],
  ) {
    const images = yield* pi(() => context.runtime.acceptsImages(agent));

    const ids = unseen.flatMap((entry) =>
      (entry.files ?? []).map((file) => file.id),
    );

    const entries = yield* context.library.entries(
      { kind: "group", groupId },
      ids,
    );

    const files: string[] = [];
    const omitted: string[] = [];

    for (const entry of unseen.toReversed())
      for (const item of (entry.files ?? []).toReversed()) {
        const file = entries.get(item.id);

        if (
          !images &&
          file &&
          attachmentKind(file.mimeType) === "image" &&
          file.size <= MAX_IMAGE_BYTES
        )
          omitted.unshift(file.name);
        else if (files.length < MAX_ATTACHMENTS) files.unshift(item.id);
      }

    return { files, omitted };
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
        ? ` [attached: ${entry.files.map((file) => ("deleted" in file ? "File deleted" : file.name)).join(", ")}]`
        : "";

      return `${senderLabel(entry.sender)}${reply}: ${entry.text}${files}`;
    });

    return `Group chat ${JSON.stringify(group.name)}. You are ${name}; the other members are the owner and ${members.join(", ") || "no other bots"}.\n\nNew messages:\n\n${messages.join("\n\n")}`;
  });

  return { summarize, turnAttachments, turnInput };
};

export type GroupTurnInput = ReturnType<typeof groupTurnInput>;
