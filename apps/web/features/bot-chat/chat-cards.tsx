import { botRequestResult } from "@/features/bot-requests/bot-request-card";
import { desktopScreenshotResult } from "@/features/bot-desktop/desktop-screenshot";
import { credentialRequestResult } from "@/features/credentials/credential-request";
import { heldActionEvent } from "@/features/bot-desktop/held-action";
import { jobResult } from "@/features/jobs/job-card";
import { jobQuestionEvent } from "@/features/jobs/job-question";
import { loginRequestResult } from "@/features/logins/login-request";
import { isJobKind } from "@crumble/server/contract/tools";
import type { Message } from "@/features/chat/api";
import { displayResult } from "@/features/chat/display";
import type { MessageCard, CardChat } from "@/features/chat/message-card";
import { EventRow, hasContent, hasText } from "@/features/chat/transcript";

const TOOL_RESULTS: MessageCard[] = [
  displayResult,
  desktopScreenshotResult,
  credentialRequestResult,
  loginRequestResult,
  botRequestResult,
  jobResult,
];

const EVENTS: MessageCard[] = [jobQuestionEvent, heldActionEvent];

function cardOf(message: Message, cards = TOOL_RESULTS) {
  for (const parse of cards) {
    const card = parse(message);

    if (card) return card;
  }

  return null;
}

export function shownInChat(message: Message) {
  switch (message.role) {
    case "user":
      return hasContent(message) && !isJobKind(message.origin?.kind);
    case "assistant":
      return hasText(message);
    case "toolResult":
      return cardOf(message) !== null;
    case "event":
      return message.content.trim() !== "";
    default:
      return false;
  }
}

export function ToolResultRow({
  message,
  chat,
}: {
  message: Message;
  chat: CardChat;
}) {
  return cardOf(message)?.(chat) ?? null;
}

/** An event in the chat: a card the owner acts on, such as a job's question, or a plain event row. */
export function EventMessage({
  message,
  chat,
}: {
  message: Message;
  chat: CardChat;
}) {
  return cardOf(message, EVENTS)?.(chat) ?? <EventRow message={message} />;
}
