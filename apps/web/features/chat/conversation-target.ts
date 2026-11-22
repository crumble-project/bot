import type { UseQueryOptions } from "@tanstack/react-query";
import type { RoutePath } from "@/lib/api";
import type { HistoryPage, Message } from "./api";
import type { ReactionTarget } from "./transcript";

export type HistoryRoute = "history";

export type ConversationTarget<S extends HistoryPage> = {
  /** `bot:<id>`, which keys its drafts and outgoing messages. */
  key: string;
  path: `/v1/agents/${string}`;
  history: RoutePath<HistoryRoute>;
  query: UseQueryOptions<S, Error, S, string[]>;
  shown: (message: Message) => boolean;
  reactionTarget: ReactionTarget;
  sendContext: () => { timezone?: string };
  stop: () => Promise<void>;
  followsAfterView: (snapshot: S) => boolean;
  refreshList: () => Promise<void>;
};
