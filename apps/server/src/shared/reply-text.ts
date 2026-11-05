import type { AssistantMessage } from "@earendil-works/pi-ai";

export const replyText = ({ content }: Pick<AssistantMessage, "content">) =>
  content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
