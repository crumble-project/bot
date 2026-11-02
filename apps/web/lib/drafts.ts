const PREFIX = "crumble.draft:";

/** The unsent text of a chat's composer, such as `bot:<id>`, kept across page changes and reloads. */
export const readDraft = (chat: string) =>
  localStorage.getItem(`${PREFIX}${chat}`) ?? "";

export function saveDraft(chat: string, text: string) {
  if (text) localStorage.setItem(`${PREFIX}${chat}`, text);
  else localStorage.removeItem(`${PREFIX}${chat}`);
}

/** Forgets every chat's draft, as when another person signs in on this browser. */
export function clearDrafts() {
  const keys = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  );

  for (const key of keys)
    if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
}
