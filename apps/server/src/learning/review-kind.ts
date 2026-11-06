import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineExtension,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";
import type { AgentRuntime } from "../bots/runtime";
import type { ConversationKind } from "../bot-ports/conversation-kind";
import { defineAnchorTask } from "../shared/anchor-task";
import type { Agent } from "../contract/agents";
import { localConversationId } from "../shared/entry-ids";
import { groupOf } from "../group-chats/group-conversation";
import {
  ReviewConversation,
  reviewOf,
} from "../learned-changes/review-conversation";
import { reviewInstructions, type ReviewScope } from "./review-instructions";

export const REVIEW_EXTENSION = "learning-review";

// Owns a review conversation, so it stays out of the bot chat transcript, like a group conversation's anchor.
export const ReviewAnchor = defineAnchorTask("crumble.review-anchor");

export class ReviewBudgetExceeded extends Error {
  constructor(spent: number, budget: number) {
    super(
      `The review stopped before exceeding its input budget (${spent} of ${budget} characters sent)`,
    );
  }
}

/**
 * The review extension: the anchor task, and a generation hook that adds up the input of every model request the
 * review makes and stops the review before a request would exceed the budget. Spending lives in memory, since a
 * restart drops reviews anyway.
 */
function reviewExtension() {
  const spent = new Map<string, number>();

  const budget = hook(GenerationTask, {
    beforeRequest: async (request, api, context) => {
      const review = await reviewOf(api, api.conversationId, context);

      if (!review?.budgetChars) return undefined;
      const key = String(api.conversationId);
      const used = spent.get(key) ?? 0;
      const next = used + JSON.stringify(request.messages).length;

      if (next > review.budgetChars) {
        spent.delete(key);
        throw new ReviewBudgetExceeded(next, review.budgetChars);
      }

      spent.set(key, next);

      return undefined;
    },
  });

  return defineExtension({
    name: REVIEW_EXTENSION,
    tasks: [ReviewAnchor],
    hooks: [budget],
  });
}

export const reviewModelOf = (agent: Agent) =>
  agent.reviewModel ?? { provider: agent.provider, model: agent.model };

export function reviewConversations(): ConversationKind {
  const extension = reviewExtension();

  return {
    extension,
    recognize: async (reader, conversationId, context) => {
      const review = await reviewOf(reader, conversationId, context);

      if (!review) return undefined;

      return {
        tools: (parts) => [
          ...(review.memory ? parts.memory : []),
          ...parts.skill,
          ...(review.skills ? [parts.skillManage] : []),
        ],
        extensions: (parts) => [
          parts.memoryExtension,
          parts.skillExtension,
          parts.visionExtension,
          extension,
        ],
        prompt: {
          standing: (agent) => [
            reviewInstructions(review),
            `Your standing instructions in the owner's chat, which the turn followed:\n${agent.instructions}`,
          ],
          skillWriting: review.skills,
        },
        model: reviewModelOf,
        noEnvironment: true,
      };
    },
  };
}

export async function openReviewConversation(
  runtime: Pick<AgentRuntime, "documents" | "openAnchored">,
  agent: Agent,
  reviewed: { id: string; conversationId: string },
  scope: ReviewScope,
  budgetChars: number,
) {
  const reviewedGroup = await groupOf(
    await runtime.documents(agent),
    localConversationId(agent.id, reviewed.conversationId),
    BACKGROUND_CONTEXT,
  );

  return runtime.openAnchored(agent, ReviewAnchor, async (tx, id) => {
    const doc = await tx.doc(ReviewConversation, id);
    doc.executionId = reviewed.id;
    doc.groupId = reviewedGroup;
    doc.skills = scope.skills;
    doc.memory = scope.memory;
    doc.budgetChars = budgetChars;
  });
}
