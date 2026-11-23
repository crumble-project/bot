import type {
  ConversationId,
  DocumentId,
  EntryId,
  Id,
  SubmissionId,
} from "@earendil-works/pi-durable";
import { InvalidInput } from "./errors";
import type { NotFound } from "./errors";

/** pi-durable mints every record ID as a non-negative safe integer and erases the brand at runtime. */
const isDurableId = <I extends Id<string>>(value: number): value is I =>
  Number.isSafeInteger(value) && value >= 0;

/** What a number becomes once it is one of pi-durable's record IDs again: a stored ID, or a bound derived from one. */
export const durableId = <I extends Id<string>>(value: number): I => {
  if (!isDurableId<I>(value)) {
    throw new Error(`Invalid durable record ID: ${value}`);
  }

  return value;
};

export const entryIdOf = (value: number): EntryId => durableId<EntryId>(value);

export const conversationIdOf = (value: number): ConversationId =>
  durableId<ConversationId>(value);

export const documentIdOf = (value: number): DocumentId =>
  durableId<DocumentId>(value);

export const submissionIdOf = (value: number): SubmissionId =>
  durableId<SubmissionId>(value);

const ENTRY = /^[1-9][0-9]*$/;
const MESSAGE_INDEX = /^(0|[1-9][0-9]*)$/;

export const positiveId = (raw: string) =>
  ENTRY.test(raw) && Number.isSafeInteger(Number(raw))
    ? Number(raw)
    : undefined;

/** `<owner>:<n>`: a durable entry or conversation of a bot. Entry numbers are unique across its conversations. */
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
  if (owner === undefined) {
    return Number(value.slice(value.lastIndexOf(":") + 1));
  }

  const prefix = `${owner}:`;

  if (!value.startsWith(prefix)) {
    return "foreign";
  }

  return positiveId(value.slice(prefix.length)) ?? "malformed";
}

export function parseEntryRef(
  owner: string,
  value: string,
  label: string,
  Failure: typeof InvalidInput | typeof NotFound = InvalidInput,
): number {
  const entry = parseEntryId(value, owner);

  if (entry === "foreign") {
    throw new Failure({ message: `${label} belongs to a different agent` });
  }

  if (entry === "malformed") {
    throw new Failure({ message: `Invalid ${label}` });
  }

  return entry;
}

export const localConversationId = (
  agentId: string,
  reference: string,
): ConversationId =>
  conversationIdOf(parseEntryRef(agentId, reference, "Conversation"));

export function parseMessageIndex(entryId: string, messageId: string) {
  const prefix = `${entryId}:`;
  const raw = messageId.slice(prefix.length);

  return messageId.startsWith(prefix) &&
    MESSAGE_INDEX.test(raw) &&
    Number.isSafeInteger(Number(raw))
    ? Number(raw)
    : undefined;
}
