import {
  defineDoc,
  type ConversationId,
  type DocumentReader,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

export const GroupConversation = defineDoc<{ groupId: string | null }>({
  kind: "crumble.group-conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ groupId: null }),
  checkpointWhen: () => false,
});

export const groupOf = async (
  reader: DocumentReader,
  conversationId: ConversationId,
  context: Context,
) =>
  (await reader.snapshot(GroupConversation, conversationId, context))
    ?.groupId ?? null;
