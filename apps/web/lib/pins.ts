import { useRef, useState } from "react";
import {
  MAX_PINS,
  pinnedConversations,
} from "@crumble/server/contract/user-preferences";
import { authClient } from "@/lib/auth-client";

type Conversation = { id: string };

export const botPin = (id: string) => `agent:${id}`;

const savedPins = (stored: unknown) => {
  const parsed = pinnedConversations.safeParse(stored);

  return parsed.success ? parsed.data : [];
};

export type Pins = {
  pinned: Array<string>;

  ready: boolean;
  isPinned: (key: string) => boolean;
  canPin: (key: string) => boolean;
  pin: (key: string) => void;
  unpin: (key: string) => void;
  move: (key: string, target: string) => void;
};

export function usePins(bots: Array<Conversation> | undefined): Pins {
  const session = authClient.useSession();
  const [wanted, setWanted] = useState<Array<string> | null>(null);

  const writes = useRef<{ next: Array<string> | null; running: boolean }>({
    next: null,
    running: false,
  });

  const { refetch } = session;

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
