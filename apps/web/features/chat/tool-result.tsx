import type { ComponentType, ReactNode } from "react";
import type { JobRef } from "@/lib/job-kinds";
import type { Message } from "./api";

/** What a tool result's card may ask of the chat around it. */
export type ToolResultChat = {
  botId: string;
  /** Where the chat's images are read. */
  attachmentPath: (entryId: string, index: number) => string;
  /** The job's current status, once the chat has read its jobs. */
  jobStatus: (job: JobRef) => string | undefined;
  onOpenJob: (job: JobRef) => void;
};

/** A tool result the chat shows: its card, or null for any message that isn't one. */
export type ToolResult = (
  message: Message,
) => ((chat: ToolResultChat) => ReactNode) | null;

/** The entry a feature contributes to `TOOL_RESULTS`: a message shows when `parse` reads it, as `Card`. */
export const toolResult =
  <T,>(
    parse: (message: Message) => T | null,
    Card: ComponentType<{ result: T; chat: ToolResultChat }>,
  ): ToolResult =>
  (message) => {
    const result = parse(message);

    return result === null
      ? null
      : (chat) => <Card result={result} chat={chat} />;
  };
