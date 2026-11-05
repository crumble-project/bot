const ENTRY = /^[1-9][0-9]*$/;
const MESSAGE_INDEX = /^(0|[1-9][0-9]*)$/;

/** `<owner>:<n>`: a durable entry or conversation of a bot or group. Entry numbers are unique across its conversations. */
export const formatEntryId = (owner: string, id: number) => `${owner}:${id}`;

/** `<entry>:<index>`: one model message of an entry. */
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

  const raw = value.slice(prefix.length);

  return ENTRY.test(raw) && Number.isSafeInteger(Number(raw))
    ? Number(raw)
    : "malformed";
}

/** The index of a message of `entryId`, or undefined when `messageId` isn't one. */
export function parseMessageIndex(entryId: string, messageId: string) {
  const prefix = `${entryId}:`;
  const raw = messageId.slice(prefix.length);

  return messageId.startsWith(prefix) &&
    MESSAGE_INDEX.test(raw) &&
    Number.isSafeInteger(Number(raw))
    ? Number(raw)
    : undefined;
}
