import { MARK_QUESTION_TOOL_NAME } from "../contract/tools";
import { isOwnerOrigin } from "./origins";
import { isToolResult } from "./tool-results";
import { isOwnerInput, textOf, toolCalls } from "./transcript";
import type { TranscriptMessage } from "./transcript";

const ownerSaid = (message: TranscriptMessage) =>
  isOwnerInput(message) &&
  (message.origin === undefined || isOwnerOrigin(message.origin));

const writtenReply = (message: TranscriptMessage) =>
  message.role === "assistant" && Boolean(textOf(message)?.trim());

const callOf = (before: Array<TranscriptMessage>, result: TranscriptMessage) =>
  before.findLast(
    (message) =>
      message.role === "assistant" &&
      toolCalls(message).some(
        (call) =>
          call.name === MARK_QUESTION_TOOL_NAME &&
          (result.toolCallId === undefined || call.id === result.toolCallId),
      ),
  );

export function chatQuestionOpen(
  messages: Array<TranscriptMessage>,
  answeringOwner: boolean,
): boolean {
  if (answeringOwner) {
    return false;
  }
  const after = messages.slice(messages.findLastIndex(ownerSaid) + 1);

  const marked = after.findIndex((message) =>
    isToolResult(message, MARK_QUESTION_TOOL_NAME),
  );
  const result = after[marked];

  if (!result) {
    return false;
  }
  const call = callOf(after.slice(0, marked), result);

  return (
    (call !== undefined && writtenReply(call)) ||
    after.slice(marked + 1).some(writtenReply)
  );
}
