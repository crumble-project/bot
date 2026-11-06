import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, Cursor, Tx } from "@earendil-works/pi-durable";
import { contentText } from "../transcript/entries";
import { clip } from "../shared/limits";

const EXCERPT_MESSAGES = 12;
const EXCERPT_CHARS = 8000;
const MESSAGE_CHARS = 2000;
const SCAN_PAGE = 50;

const SCAN_PAGES = 10;

const textOf = (message: Message) => {
  if (message.role !== "user" && message.role !== "assistant") return "";

  return contentText(message.content).trim();
};

function entryLines(messages: readonly Message[]) {
  return messages.toReversed().flatMap((message) => {
    const text = textOf(message);

    return text
      ? [
          `${message.role === "user" ? "Owner" : "Bot"}: ${clip(text, MESSAGE_CHARS)}`,
        ]
      : [];
  });
}

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
