import type { Message } from "@/features/chat/api";
import { AttachmentImage } from "@/features/chat/transcript";
import { messageCard } from "@/features/chat/message-card";
import { DESKTOP_SCREENSHOT_TOOL_NAME } from "@crumble/server/contract/tools";

/** A successful `desktop_screenshot` result, whose image is its entry's attachment 0. */
const screenshotOf = (message: Message) =>
  message.role === "toolResult" &&
  message.toolName === DESKTOP_SCREENSHOT_TOOL_NAME &&
  !message.isError
    ? message
    : null;

export const desktopScreenshotResult = messageCard(
  screenshotOf,
  ({ result, chat }) => (
    <AttachmentImage
      name="Desktop screenshot"
      path={chat.attachmentPath(result.entryId, 0)}
      className="max-h-[32rem]"
    />
  ),
);
