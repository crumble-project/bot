import type {
  ConversationId,
  Cursor,
  EntryRecord,
  Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { OWNER_MESSAGE_SOURCES } from "../shared/domain";
import { MESSAGE_ENTRY } from "../transcript/entries";
import { requestSource } from "../transcript/origins";

export type OwnerMessage = {
  requestId: string;
  text: string;
  from: (typeof OWNER_MESSAGE_SOURCES)[number];
};

export type JobRequest = {
  ownerMessages: OwnerMessage[];
  tasks: string[];
  job?: { name: string; chatId: ConversationId };
};

const ownerEntry = z.object({
  text: z.string(),
  requestId: z.string(),
  origin: z.object({ kind: z.string() }),
});

const SCAN_PAGE = 200;

function ownerMessageOf(entry: EntryRecord): OwnerMessage | undefined {
  if (entry.kind !== MESSAGE_ENTRY) return undefined;

  const data = ownerEntry.safeParse(entry.data).data;
  const from = data && requestSource(data.origin.kind);

  return data && from
    ? { requestId: data.requestId, text: data.text, from }
    : undefined;
}

async function* newestOwnerMessages(
  tx: Pick<Tx, "scanEntries">,
  chatId: ConversationId,
) {
  let cursor: Cursor | undefined;

  do {
    const page = await tx.scanEntries(
      { conversationId: chatId, order: "descending" },
      SCAN_PAGE,
      cursor,
    );

    for (const entry of page.items) {
      const message = ownerMessageOf(entry);

      if (message) yield message;
    }

    cursor = page.next;
  } while (cursor);
}

export async function ownerMessages(
  tx: Pick<Tx, "scanEntries">,
  chatId: ConversationId,
  cited: readonly string[],
): Promise<{ messages: OwnerMessage[] } | { unknown: string[] }> {
  const wanted = new Set(cited);
  const found: OwnerMessage[] = [];
  let latest: OwnerMessage | undefined;

  for await (const message of newestOwnerMessages(tx, chatId)) {
    latest ??= message;

    if (wanted.delete(message.requestId)) found.unshift(message);

    if (!wanted.size) break;
  }

  if (wanted.size > 0) return { unknown: [...wanted] };

  if (latest && !found.some((each) => each.requestId === latest.requestId))
    found.push(latest);

  return { messages: found };
}

export function addToRequest(
  request: JobRequest,
  job: NonNullable<JobRequest["job"]>,
  messages: OwnerMessage[],
  task: string,
) {
  request.job = job;

  for (const message of messages)
    if (
      !request.ownerMessages.some(
        (each) => each.requestId === message.requestId,
      )
    )
      request.ownerMessages.push(message);

  request.tasks.push(task);
}
