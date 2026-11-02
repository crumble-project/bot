import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, Cursor, Tx } from "@earendil-works/pi-durable";

const EXCERPT_MESSAGES = 12;
const EXCERPT_CHARS = 8000;
const MESSAGE_CHARS = 2000;
const SCAN_PAGE = 50;

// A long run of tool activity yields no text; the scan stops there rather than reading the whole chat.
const SCAN_PAGES = 10;

const textOf = (message: Message) => {
  if (message.role !== "user" && message.role !== "assistant") return "";

  if (!Array.isArray(message.content)) return message.content.trim();

  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
};

const clip = (text: string) =>
  text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS - 1)}…` : text;

/** An entry's said lines, newest first. */
function entryLines(messages: readonly Message[]) {
  return messages.toReversed().flatMap((message) => {
    const text = textOf(message);

    return text
      ? [`${message.role === "user" ? "Owner" : "Bot"}: ${clip(text)}`]
      : [];
  });
}

/** What the chat's model saw said, newest first: the owner's side and the bot's text, without tool calls or results. */
async function* newestMessages(
  tx: Pick<Tx, "scanEntries">,
  chatId: ConversationId,
) {
  let cursor: Cursor | undefined;
  let pages = 0;

  do {
    const page = await tx.scanEntries(
      { conversationId: chatId, order: "descending" },
      SCAN_PAGE,
      cursor,
    );

    for (const entry of page.items) yield* entryLines(entry.model ?? []);

    cursor = page.next;
  } while (cursor && ++pages < SCAN_PAGES);
}

/**
 * The chat's latest messages, oldest first, for a job it starts: what was said, not the bot's work. Bounded in count
 * and length, so a long chat costs a job no more than a short one. Empty when the chat has none.
 */
export async function chatExcerpt(
  tx: Pick<Tx, "scanEntries">,
  chatId: ConversationId,
): Promise<string> {
  const lines: string[] = [];
  let length = 0;

  for await (const line of newestMessages(tx, chatId)) {
    if (length + line.length > EXCERPT_CHARS) break;
    lines.unshift(line);
    length += line.length;

    if (lines.length === EXCERPT_MESSAGES) break;
  }

  return lines.join("\n\n");
}
