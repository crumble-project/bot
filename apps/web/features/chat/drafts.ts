import { onSessionReset } from "@/lib/session";

const PREFIX = "crumble.draft:";

try {
  const keys = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  );

  for (const key of keys) {
    if (key?.startsWith(`${PREFIX}group:`)) {
      localStorage.removeItem(key);
    }
  }
} catch {}

export const readDraft = (chat: string) =>
  localStorage.getItem(`${PREFIX}${chat}`) ?? "";

export function saveDraft(chat: string, text: string) {
  try {
    if (text) {
      localStorage.setItem(`${PREFIX}${chat}`, text);
    } else {
      localStorage.removeItem(`${PREFIX}${chat}`);
    }
  } catch {
    return;
  }
}

onSessionReset(() => {
  const keys = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  );

  for (const key of keys) {
    if (key?.startsWith(PREFIX)) {
      localStorage.removeItem(key);
    }
  }
});
