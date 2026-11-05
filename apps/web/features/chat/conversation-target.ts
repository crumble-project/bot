import type { UseQueryOptions } from "@tanstack/react-query";
import type { RoutePath } from "@/lib/api";
import type { HistoryPage, Message } from "./api";
import type { ReactionTarget } from "./transcript";

export type HistoryRoute = "history" | "groupChatHistory";

/** What makes a bot chat or a group chat one conversation: `useConversation` drives either from this. */
export type ConversationTarget<S extends HistoryPage> = {
  /** `bot:<id>` or `group:<id>`, which keys its drafts and outgoing messages. */
  key: string;
  path: `/v1/agents/${string}` | `/v1/group-chats/${string}`;
  history: RoutePath<HistoryRoute>;
  query: UseQueryOptions<S, Error, S, string[]>;
  shown: (message: Message) => boolean;
  reactionTarget: ReactionTarget;
  /** Sent along with each message. */
  sendContext: () => { timezone?: string };
  stop: () => Promise<void>;
  /** Whether its stream keeps following with no view open. */
  followsAfterView: (snapshot: S) => boolean;
  /** Reads the list it appears in anew, once it is gone. */
  refreshList: () => Promise<void>;
};
