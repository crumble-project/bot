import { useSyncExternalStore } from "react";
import { send } from "@/lib/api";
import type { Upload } from "./composer";

export type Outgoing = {
  requestId: string;
  content: string;
  replyTo?: string;
  uploads: Upload[];
  state: "sending" | "failed";
  createdAt: number;
};

const outgoing = new Map<string, Outgoing[]>();
const listeners = new Set<() => void>();
const EMPTY: Outgoing[] = [];

function update(chat: string, change: (list: Outgoing[]) => Outgoing[]) {
  outgoing.set(chat, change(outgoing.get(chat) ?? []));

  for (const listener of listeners) listener();
}

/** Messages sent to `chat` that its transcript does not show yet. */
export function useOutgoing(chat: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    () => outgoing.get(chat) ?? EMPTY,
  );
}

/** Drops messages the transcript now contains, matched by request ID. */
export function confirm(chat: string, requestIds: Set<string>) {
  const list = outgoing.get(chat);

  if (list?.some((message) => requestIds.has(message.requestId)))
    update(chat, (current) =>
      current.filter((message) => !requestIds.has(message.requestId)),
    );
}

/**
 * Sends a message and shows it at once; it stays until a snapshot confirms it.
 * A retry reuses the request ID and files, so the server can tell it is the same message.
 */
export async function deliver(
  chat: string,
  path: string,
  message: Omit<Outgoing, "state" | "createdAt">,
  extra: { timezone?: string } = {},
) {
  update(chat, (list) => [
    ...list.filter((each) => each.requestId !== message.requestId),
    { ...message, state: "sending", createdAt: Date.now() },
  ]);

  try {
    await send(path, "POST", {
      content: message.content,
      requestId: message.requestId,
      ...(message.replyTo && { replyTo: message.replyTo }),
      ...(message.uploads.length > 0 && {
        attachments: message.uploads.map(({ name, mimeType, data }) => ({
          name,
          mimeType,
          data,
        })),
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

    return error instanceof Error ? error.message : "Message was not sent";
  }
}
