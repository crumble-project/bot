import { botRequestResult } from "@/features/bot-requests/bot-request-card";
import { desktopScreenshotResult } from "@/features/bot-desktop/desktop-screenshot";
import { credentialRequestResult } from "@/features/credentials/credential-request";
import { jobResult } from "@/features/jobs/job-card";
import { loginRequestResult } from "@/features/logins/login-request";
import { isJobKind } from "@/lib/job-kinds";
import type { Message } from "./api";
import { displayResult } from "./display";
import type { ToolResult, ToolResultChat } from "./tool-result";
import { hasContent, hasText } from "./transcript";

const TOOL_RESULTS: ToolResult[] = [
  displayResult,
  desktopScreenshotResult,
  credentialRequestResult,
  loginRequestResult,
  botRequestResult,
  jobResult,
];

function cardOf(message: Message) {
  for (const result of TOOL_RESULTS) {
    const card = result(message);

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
  chat: ToolResultChat;
}) {
  return cardOf(message)?.(chat) ?? null;
}
