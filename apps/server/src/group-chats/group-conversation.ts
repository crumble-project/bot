import {
  defineDoc,
  type ConversationId,
  type DocumentReader,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

/** Marks a bot's conversation as its working context for one group chat. */
export const GroupConversation = defineDoc<{ groupId: string | null }>({
  kind: "crumble.group-conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ groupId: null }),
  checkpointWhen: () => false,
});

/** The group chat a conversation works for; null for any other conversation. */
export const groupOf = async (
  reader: DocumentReader,
  conversationId: ConversationId,
  context: Context,
) =>
  (await reader.snapshot(GroupConversation, conversationId, context))
    ?.groupId ?? null;
