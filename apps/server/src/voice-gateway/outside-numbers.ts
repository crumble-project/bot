// German premium and service numbers, international premium, and satellite networks; the voice gateway mirrors it.
const BLOCKED_PREFIXES = [
  "0900",
  "0137",
  "0180",
  "118",
  "+49900",
  "+49137",
  "+49180",
  "+49118",
  "+979",
  "+870",
  "+881",
  "+882",
];

const normalized = (raw: string) =>
  raw.replaceAll(/[ \-.()[\]{}]/gu, "").replace(/^00/u, "+");

/**
 * The number rules for an outside call, checked when the bot asks and again at approval. The owner approves the exact
 * digits, so these stop only mistakes and the costliest abuse.
 */
export function outsideNumber(
  raw: string,
  ownerNumbers: readonly string[],
): { number: string; refusal: null } | { number: null; refusal: string } {
  const number = normalized(raw);
  const refused = (refusal: string) => ({ number: null, refusal });

  if (!/^\+?[0-9]+$/u.test(number))
    return refused(
      "The number may contain only digits, with one leading +, after spaces, dashes, dots, and brackets are removed.",
    );

  const digits = number.replace("+", "").length;

  if (digits < 5 || digits > 15)
    return refused("The number must have 5 to 15 digits.");

  if (BLOCKED_PREFIXES.some((prefix) => number.startsWith(prefix)))
    return refused("Premium, service, and satellite numbers cannot be called.");

  if (ownerNumbers.some((owner) => normalized(owner) === number))
    return refused("That is one of the owner's numbers.");

  return { number, refusal: null };
}
