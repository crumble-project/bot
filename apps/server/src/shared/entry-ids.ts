import type { ConversationId } from "@earendil-works/pi-durable";
import { InvalidInput, type NotFound } from "./errors";

const ENTRY = /^[1-9][0-9]*$/;
const MESSAGE_INDEX = /^(0|[1-9][0-9]*)$/;

export const positiveId = (raw: string) =>
  ENTRY.test(raw) && Number.isSafeInteger(Number(raw))
    ? Number(raw)
    : undefined;

/** `<owner>:<n>`: a durable entry or conversation of a bot or group. Entry numbers are unique across its conversations. */
export const formatEntryId = (owner: string, id: number) => `${owner}:${id}`;

export const formatMessageId = (entryId: string, index: number) =>
  `${entryId}:${index}`;

/**
 * Lenient: the number after the last colon, whoever owns the ID, and `NaN` when there is none. Orders IDs that were
 * read back from a transcript. Strict: `owner`'s positive safe integer, or why `value` isn't one.
 */
export function parseEntryId(value: string): number;
export function parseEntryId(
  value: string,
  owner: string,
): number | "foreign" | "malformed";
export function parseEntryId(value: string, owner?: string) {
  if (owner === undefined)
    return Number(value.slice(value.lastIndexOf(":") + 1));

  const prefix = `${owner}:`;

  if (!value.startsWith(prefix)) return "foreign";

  return positiveId(value.slice(prefix.length)) ?? "malformed";
}

export function parseEntryRef(
  owner: string,
  value: string,
  label: string,
  Failure: typeof InvalidInput | typeof NotFound = InvalidInput,
): number {
  const entry = parseEntryId(value, owner);

  if (entry === "foreign")
    throw new Failure({ message: `${label} belongs to a different agent` });

  if (entry === "malformed") throw new Failure({ message: `Invalid ${label}` });

  return entry;
}

export const localConversationId = (
  agentId: string,
  reference: string,
): ConversationId =>
  // SAFETY: validated decimal IDs are branded by pi-durable at this boundary.
  parseEntryRef(agentId, reference, "Conversation") as ConversationId;

export function parseMessageIndex(entryId: string, messageId: string) {
  const prefix = `${entryId}:`;
  const raw = messageId.slice(prefix.length);

  return messageId.startsWith(prefix) &&
    MESSAGE_INDEX.test(raw) &&
    Number.isSafeInteger(Number(raw))
    ? Number(raw)
    : undefined;
}
