export const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

const wordCharacter = /[\p{L}\p{N}_]/u;

export function mentionedMembers(
  text: string,
  members: Array<{ id: string; name: string }>,
  senderId?: string,
): string[] {
  const source = normalize(text);

  const candidates = members
    .flatMap((member) => {
      const name = normalize(member.name.trim());

      return name ? [{ id: member.id, name }] : [];
    })
    .sort((a, b) => b.name.length - a.name.length);

  const found: string[] = [];

  for (
    let at = source.indexOf("@");
    at >= 0;
    at = source.indexOf("@", at + 1)
  ) {
    // An @ inside a word belongs to an email address.
    if (at > 0 && wordCharacter.test(source[at - 1]!)) continue;

    const match = candidates.find(
      (member) =>
        source.startsWith(member.name, at + 1) &&
        !wordCharacter.test(source[at + 1 + member.name.length] ?? ""),
    );

    if (match && match.id !== senderId && !found.includes(match.id))
      found.push(match.id);
  }

  return found;
}

const ownerMention = /(?<![\p{L}\p{N}_])@owner(?![\p{L}\p{N}_])/iu;

export function mentionsOwner(text: string) {
  return ownerMention.test(text.normalize("NFKC"));
}
