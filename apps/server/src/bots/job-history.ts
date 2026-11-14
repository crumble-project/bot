import { z } from "zod";
import type { jobHistoryResponse } from "../contract/api-responses";
import { COMPUTER_USE_TOOL_NAME } from "../contract/tools";
import type {
  TranscriptMessage,
  TranscriptPage,
} from "../transcript/transcript";
import { parseEntryId } from "../shared/entry-ids";

type Item = z.infer<typeof jobHistoryResponse>["items"][number];

type Step = Extract<Item, { kind: "step" }>;

const steps = new Map<string, { label: string; icon: Step["icon"] }>([
  ["bash", { label: "Ran", icon: "terminal" }],
  ["read", { label: "Read", icon: "file" }],
  ["write", { label: "Wrote", icon: "pencil" }],
  ["edit", { label: "Edited", icon: "pencil" }],
  [COMPUTER_USE_TOOL_NAME, { label: "Used the bot desktop", icon: "pointer" }],
]);

export function jobItems(
  messages: TranscriptMessage[],
  results: TranscriptMessage[],
): Item[] {
  const byCall = new Map(
    results.flatMap((message) =>
      message.role === "toolResult" && message.toolCallId
        ? [[message.toolCallId, message] as const]
        : [],
    ),
  );

  return messages.flatMap((message): Item[] => {
    if (message.role === "user" && message.content.trim())
      return [{ kind: "task", id: message.id, text: message.content }];

    if (message.role !== "assistant") return [];

    return (message.blocks ?? []).flatMap((block, index): Item[] => {
      if (block.type === "text" && block.text.trim())
        return [
          { kind: "reply", id: `${message.id}:${index}`, text: block.text },
        ];

      if (block.type !== "toolCall" || !block.name) return [];

      const detail = steps.get(block.name) ?? {
        label: block.name.charAt(0).toUpperCase() + block.name.slice(1),
        icon: "tool" as const,
      };

      const subject = z
        .string()
        .safeParse(block.arguments["command"] ?? block.arguments["path"]).data;

      const result = byCall.get(block.id);

      const step: Step = {
        kind: "step",
        id: block.id,
        tool: block.name,
        ...detail,
      };

      if (subject !== undefined) step.subject = subject;

      if (result) step.result = { ...result, replyReferences: [] };

      return [step];
    });
  });
}

export async function projectJobPage(
  page: TranscriptPage,
  boundary: string | undefined,
  readNewer: (before: string | undefined) => Promise<TranscriptPage>,
) {
  const results = [...page.messages];

  if (boundary) {
    let before: string | undefined;

    do {
      const newer = await readNewer(before);

      results.push(...newer.messages);
      before =
        newer.hasMore &&
        newer.oldestEntryId !== null &&
        parseEntryId(newer.oldestEntryId) > parseEntryId(boundary)
          ? newer.oldestEntryId
          : undefined;
    } while (before);
  }

  return { ...page, items: jobItems(page.messages, results) };
}
