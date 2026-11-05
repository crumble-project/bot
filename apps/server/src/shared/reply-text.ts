import type { AssistantMessage } from "@earendil-works/pi-ai";

/** The model's words: its text blocks joined as they streamed, with nothing between them. */
export const replyText = ({ content }: Pick<AssistantMessage, "content">) =>
  content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
