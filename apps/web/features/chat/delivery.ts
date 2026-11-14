import { useSyncExternalStore } from "react";
import { HttpError, type RoutePath, send } from "@/lib/api";
import { onSessionReset } from "@/lib/session";
import type { Message } from "./api";
import type { Upload } from "./composer";

export type Outgoing = {
  requestId: string;
  content: string;
  replyTo?: string;
  uploads: Upload[];
  state: "sending" | "failed";
};

export const outgoingMessage = (message: Outgoing): Message => ({
  id: `local:${message.requestId}`,
  entryId: "",
  role: "user",
  content: message.content,
  replyReferences: [],
});

const outgoing = new Map<string, Outgoing[]>();
const listeners = new Set<() => void>();
const EMPTY: Outgoing[] = [];

function update(chat: string, change: (list: Outgoing[]) => Outgoing[]) {
  outgoing.set(chat, change(outgoing.get(chat) ?? []));

  for (const listener of listeners) listener();
}

onSessionReset(() => {
  outgoing.clear();

  for (const listener of listeners) listener();
});

export function useOutgoing(chat: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    () => outgoing.get(chat) ?? EMPTY,
  );
}

export function confirm(chat: string, requestIds: Set<string>) {
  const list = outgoing.get(chat);

  if (list?.some((message) => requestIds.has(message.requestId)))
    update(chat, (current) =>
      current.filter((message) => !requestIds.has(message.requestId)),
    );
}

/** Takes a message the server refused off the transcript, so it can go back to the composer. */
export function discard(chat: string, requestId: string) {
  update(chat, (list) => list.filter((each) => each.requestId !== requestId));
}

/**
 * Sends a message and shows it at once; it stays until a snapshot confirms it.
 * A retry reuses the request ID and files, so the server can tell it is the same message.
 * `rejected` says the server answered and refused it; after any other failure it may still have arrived.
 */
export async function deliver(
  chat: string,
  path: RoutePath<"sendMessage" | "sendGroupMessage">,
  message: Omit<Outgoing, "state">,
  extra: { timezone?: string } = {},
) {
  update(chat, (list) => [
    ...list.filter((each) => each.requestId !== message.requestId),
    { ...message, state: "sending" },
  ]);

  try {
    await send<"sendMessage" | "sendGroupMessage">(path, "POST", {
      content: message.content,
      requestId: message.requestId,
      ...(message.replyTo && { replyTo: message.replyTo }),
      ...(message.uploads.length > 0 && {
        files: message.uploads.flatMap(({ id }) => (id ? [id] : [])),
      }),
      ...extra,
    });

    return null;
  } catch (error) {
    update(chat, (list) =>
      list.map((each) =>
        each.requestId === message.requestId
          ? { ...each, state: "failed" }
          : each,
      ),
    );

    return {
      reason: error instanceof Error ? error.message : "Message was not sent",
      rejected: error instanceof HttpError && error.status < 500,
    };
  }
}
