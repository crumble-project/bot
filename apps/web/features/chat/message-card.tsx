import type { ComponentType, ReactNode } from "react";
import type { JobRef } from "@/features/jobs/api";
import type { Message } from "./api";

/** What a message's card may ask of the chat around it. */
export type CardChat = {
  botId: string;
  /** Where the chat's images are read. */
  attachmentPath: (entryId: string, index: number) => string;
  /** The job's current status, once the chat has read its jobs. */
  jobStatus: (job: JobRef) => string | undefined;
  onOpenJob: (job: JobRef) => void;
};

/** A message the chat shows as a card: its card, or null for any message that isn't one. */
export type MessageCard = (
  message: Message,
) => ((chat: CardChat) => ReactNode) | null;

/** The entry a feature contributes to the bot chat's cards: a message shows when `parse` reads it, as `Card`. */
export const messageCard =
  <T,>(
    parse: (message: Message) => T | null,
    Card: ComponentType<{ result: T; chat: CardChat }>,
  ): MessageCard =>
  (message) => {
    const result = parse(message);

    return result === null
      ? null
      : (chat) => <Card result={result} chat={chat} />;
  };
