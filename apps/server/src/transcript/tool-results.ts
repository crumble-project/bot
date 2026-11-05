import { z } from "zod";
import { jobDetails, reactionDetails } from "../contract/tool-details";
import { REACTION_TOOL_NAME } from "../contract/tools";

export const toolMetadata = z.object({
  toolCallId: z.string().optional().catch(undefined),
  toolName: z.string().optional().catch(undefined),
  isError: z.boolean().optional().catch(undefined),
  details: z.unknown().optional(),
});

/** A message as a transcript shows it (`toolDetails`) or as its entry stores it (`details`). */
type ToolResultMessage = {
  role: string;
  toolName?: string | undefined;
  isError?: boolean | undefined;
  toolDetails?: unknown;
  details?: unknown;
};

/** Whether `message` is a successful result of `toolName`. */
export const isToolResult = (message: ToolResultMessage, toolName: string) =>
  message.role === "toolResult" &&
  message.toolName === toolName &&
  !message.isError;

/** What a successful result of `toolName` stored, read with the shape its tool writes. */
export function toolResult<Details>(
  message: ToolResultMessage,
  toolName: string,
  details: z.ZodType<Details>,
) {
  return isToolResult(message, toolName)
    ? details.safeParse(message.toolDetails ?? message.details).data
    : undefined;
}

/** What the `react` tool accepts, which reads hold stored results to as well. */
export const EMOJI = /^\p{RGI_Emoji}$/v;

const reaction = reactionDetails.extend({ emoji: z.string().regex(EMOJI) });

/** The emoji of a successful `react` tool result; clients attach it to the latest input before it. */
export const reactionOf = (message: ToolResultMessage) =>
  toolResult(message, REACTION_TOOL_NAME, reaction)?.emoji;

/** The job a start of `toolName` shows as a card; other actions and failed calls show none. */
export const jobCardName = (toolName: string, message: ToolResultMessage) =>
  toolResult(message, toolName, jobDetails)?.name;
