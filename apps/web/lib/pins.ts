import { useRef, useState } from "react";
import {
  MAX_PINS,
  pinnedConversations,
} from "@crumble/server/contract/user-preferences";
import { authClient } from "@/lib/auth-client";

type Conversation = { id: string };

export const botPin = (id: string) => `agent:${id}`;

/** A stored list that is missing or invalid pins nothing. */
const savedPins = (stored: unknown) => {
  const parsed = pinnedConversations.safeParse(stored);

  return parsed.success ? parsed.data : [];
};

export type Pins = {
  /** The pinned conversations that exist, first pin first. */
  pinned: Array<string>;
  /** False until the bots load; until then every change is refused. */
  ready: boolean;
  isPinned: (key: string) => boolean;
  canPin: (key: string) => boolean;
  pin: (key: string) => void;
  unpin: (key: string) => void;
  move: (key: string, target: string) => void;
};

/**
 * The account's pinned conversations. Changes show at once and save the whole
 * list, one write at a time; afterwards the session's list takes over again,
 * which also rolls back a failed write.
 */
export function usePins(bots: Array<Conversation> | undefined): Pins {
  const session = authClient.useSession();
  const [wanted, setWanted] = useState<Array<string> | null>(null);

  const writes = useRef<{ next: Array<string> | null; running: boolean }>({
    next: null,
    running: false,
  });

  const { refetch } = session;

  // A list filtered to conversations that haven't loaded would wipe every pin, and so would one
  // written before the session's list arrives. A server too old to keep pins never sends one.
  const ready =
    bots !== undefined &&
    pinnedConversations.safeParse(session.data?.user.pinnedConversations)
      .success;

  const existing = new Set((bots ?? []).map(({ id }) => botPin(id)));

  const pinned = (
    wanted ?? savedPins(session.data?.user.pinnedConversations)
  ).filter((key) => existing.has(key));

  async function save() {
    const queue = writes.current;
    queue.running = true;

    while (queue.next) {
      while (queue.next) {
        const pinnedConversations = queue.next;
        queue.next = null;

        // The session is read once every write is done, so it can't show an older list in between.
        await authClient
          .updateUser({ pinnedConversations }, { disableSignal: true })
          .catch(() => null);
      }

      await refetch().catch(() => null);
    }

    queue.running = false;
    setWanted(null);
  }

  function change(next: Array<string>) {
    setWanted(next);
    writes.current.next = next;

    if (!writes.current.running) {
      void save();
    }
  }

  const isPinned = (key: string) => pinned.includes(key);

  const canPin = (key: string) =>
    ready && existing.has(key) && !isPinned(key) && pinned.length < MAX_PINS;

  return {
    pinned,
    ready,
    isPinned,
    canPin,
    pin: (key) => {
      if (canPin(key)) {
        change([...pinned, key]);
      }
    },
    unpin: (key) => {
      if (ready && isPinned(key)) {
        change(pinned.filter((each) => each !== key));
      }
    },
    move: (key, target) => {
      if (!ready || key === target || !isPinned(key) || !isPinned(target)) {
        return;
      }

      const next = pinned.filter((each) => each !== key);
      next.splice(pinned.indexOf(target), 0, key);
      change(next);
    },
  };
}
