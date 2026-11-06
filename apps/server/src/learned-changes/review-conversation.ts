import type { Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  type ConversationId,
  type DocumentReader,
} from "@earendil-works/pi-durable";

export const ReviewConversation = defineDoc<{
  executionId: string | null;
  groupId: string | null;
  skills: boolean;
  memory: boolean;
  budgetChars: number;
}>({
  kind: "crumble.review-conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    executionId: null,
    groupId: null,
    skills: false,
    memory: false,
    budgetChars: 0,
  }),
  checkpointWhen: () => false,
});

export const reviewOf = async (
  reader: DocumentReader,
  conversationId: ConversationId,
  context: Context,
) => {
  const review = await reader.snapshot(
    ReviewConversation,
    conversationId,
    context,
  );

  return review?.executionId ? review : null;
};
