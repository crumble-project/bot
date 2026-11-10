import type { ComponentType, ReactNode } from "react";
import type { JobRef } from "@/features/jobs/api";
import type { Message } from "./api";

export type CardChat = {
  botId: string;
  botName: string;
  attachmentPath: (entryId: string, index: number) => string;
  jobStatus: (job: JobRef) => string | undefined;
  onOpenJob: (job: JobRef) => void;
  /** Opens a call request's call beside the chat. */
  onOpenCall: (requestId: string) => void;
};

export type MessageCard = (
  message: Message,
) => ((chat: CardChat) => ReactNode) | null;

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
