import type {
  ConversationId,
  Cursor,
  EntryRecord,
  Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";

/** An owner message a job acts for, verbatim; a job started by an automation counts the automation's text as one. */
export type OwnerMessage = {
  requestId: string;
  text: string;
  from: "owner" | "automation";
};

/** What a job was asked: the owner's messages it concerns, and each message the bot sent it. */
export type JobRequest = {
  ownerMessages: OwnerMessage[];
  tasks: string[];
  /** The job's name and the bot chat it reports to; unset before its first start or send. */
  job?: { name: string; chatId: ConversationId };
};

// Origins whose words are the owner's request: the owner's own, or the instructions of an automation the owner set up.
// A script automation's notice is left out: it carries the command's output, which anyone the script reads can write.
const REQUEST_ORIGINS = new Map<string, OwnerMessage["from"]>([
  ["owner", "owner"],
  ["task", "automation"],
]);

/** Prefixes an owner or automation message in the bot's model context, so the bot can cite it in `owner_messages`. */
export const messageTag = (
  originKind: string | undefined,
  requestId: string | undefined,
  text: string,
) =>
  originKind !== undefined &&
  REQUEST_ORIGINS.has(originKind) &&
  requestId !== undefined
    ? `[message ${requestId}]\n${text}`
    : text;

const ownerEntry = z.object({
  text: z.string(),
  requestId: z.string(),
  origin: z.object({ kind: z.string() }),
});

const SCAN_PAGE = 200;

function ownerMessageOf(entry: EntryRecord): OwnerMessage | undefined {
  if (entry.kind !== "crumble.message") return undefined;

  const data = ownerEntry.safeParse(entry.data).data;
  const from = data && REQUEST_ORIGINS.get(data.origin.kind);

  return data && from
    ? { requestId: data.requestId, text: data.text, from }
    : undefined;
}

/** The chat's owner messages, newest first, read a page at a time. */
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

/**
 * The owner messages a start or send attaches: the cited ones, in chat order, and always the latest one. Fails with
 * the IDs that are not owner messages of this chat.
 */
export async function ownerMessages(
  tx: Pick<Tx, "scanEntries">,
  chatId: ConversationId,
  cited: readonly string[],
): Promise<{ messages: OwnerMessage[] } | { unknown: string[] }> {
  const wanted = new Set(cited);
  const found: OwnerMessage[] = [];
  let latest: OwnerMessage | undefined;

  // Reads on until every cited message and the latest one are found, however far back they are.
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

/** Adds a start's or send's owner messages and task to what the job was asked, keeping each message once. */
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
