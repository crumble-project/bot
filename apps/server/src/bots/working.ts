import type { z } from "zod";
import type { chatSnapshotResponse } from "../contract/api-responses";
import {
  HISTORY_READ_TOOL_NAME,
  HISTORY_SEARCH_TOOL_NAME,
  MEMORY_TOOL_NAME,
  WEB_EXTRACT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "../contract/tools";
import type { TranscriptMessage } from "../transcript/transcript";

export type Working = z.infer<typeof chatSnapshotResponse>["working"];

const searching = new Set([
  WEB_SEARCH_TOOL_NAME,
  WEB_EXTRACT_TOOL_NAME,
  HISTORY_SEARCH_TOOL_NAME,
  HISTORY_READ_TOOL_NAME,
]);

export function workingOf(
  status: "idle" | "running" | "failed",
  partial: string,
  messages: TranscriptMessage[],
): Working {
  if (status === "failed") return "failed";

  if (status !== "running") return "idle";

  if (partial.trim()) return "writing";
  const last = messages.at(-1);

  if (last?.role === "toolResult" && last.isError) return "struggling";

  const calls =
    last?.role === "assistant"
      ? (last.blocks ?? []).filter((block) => block.type === "toolCall")
      : [];

  if (calls.some((call) => searching.has(call.name ?? ""))) return "searching";

  if (calls.some((call) => call.name === MEMORY_TOOL_NAME))
    return "remembering";

  return calls.length ? "tinkering" : "thinking";
}
