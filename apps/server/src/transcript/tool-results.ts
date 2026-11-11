import { z } from "zod";
import { jobDetails, reactionDetails } from "../contract/tool-details";
import { REACTION_TOOL_NAME } from "../contract/tools";

export const toolMetadata = z.object({
  toolCallId: z
    .string()
    .optional()
    .catch(() => undefined),
  toolName: z
    .string()
    .optional()
    .catch(() => undefined),
  isError: z
    .boolean()
    .optional()
    .catch(() => undefined),
  details: z.unknown().optional(),
});

type ToolResultMessage = {
  role: string;
  toolName?: string | undefined;
  isError?: boolean | undefined;
  toolDetails?: unknown;
  details?: unknown;
};

export const isToolResult = (message: ToolResultMessage, toolName: string) =>
  message.role === "toolResult" &&
  message.toolName === toolName &&
  !message.isError;

export function toolResult<Details>(
  message: ToolResultMessage,
  toolName: string,
  details: z.ZodType<Details>,
) {
  return isToolResult(message, toolName)
    ? details.safeParse(message.toolDetails ?? message.details).data
    : undefined;
}

export const EMOJI = /^\p{RGI_Emoji}$/v;

const reaction = reactionDetails.extend({ emoji: z.string().regex(EMOJI) });

/** The emoji of a successful `react` tool result; clients attach it to the latest input before it. */
export const reactionOf = (message: ToolResultMessage) =>
  toolResult(message, REACTION_TOOL_NAME, reaction)?.emoji;

export const jobCardName = (toolName: string, message: ToolResultMessage) =>
  toolResult(message, toolName, jobDetails)?.name;
