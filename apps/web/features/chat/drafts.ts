import { onSessionReset } from "@/lib/session";

const PREFIX = "crumble.draft:";

export const readDraft = (chat: string) =>
  localStorage.getItem(`${PREFIX}${chat}`) ?? "";

/** Best effort: full or blocked storage loses only the saved copy, never the text being typed. */
export function saveDraft(chat: string, text: string) {
  try {
    if (text) localStorage.setItem(`${PREFIX}${chat}`, text);
    else localStorage.removeItem(`${PREFIX}${chat}`);
  } catch {
    return;
  }
}

// Another person may sign in on this browser.
onSessionReset(() => {
  const keys = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  );

  for (const key of keys)
    if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
});
