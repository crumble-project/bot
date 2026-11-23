import {
  defineExtension,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";
import type { AgentRuntime } from "../bots/runtime";
import type { ConversationKind } from "../bot-ports/conversation-kind";
import { defineAnchorTask } from "../shared/anchor-task";
import type { Agent } from "../contract/agents";
import {
  ReviewConversation,
  reviewOf,
} from "../learned-changes/review-conversation";
import { reviewInstructions } from "./review-instructions";
import type { ReviewScope } from "./review-instructions";

export const REVIEW_EXTENSION = "learning-review";

export const ReviewAnchor = defineAnchorTask("crumble.review-anchor");

export class ReviewBudgetExceeded extends Error {
  constructor(spent: number, budget: number) {
    super(
      `The review stopped before exceeding its input budget (${spent} of ${budget} characters sent)`,
    );
  }
}

function reviewExtension() {
  const spent = new Map<string, number>();

  const budget = hook(GenerationTask, {
    beforeRequest: async (request, api, context) => {
      const review = await reviewOf(api, api.conversationId, context);

      if (!review?.budgetChars) {
        return;
      }
      const key = String(api.conversationId);
      const used = spent.get(key) ?? 0;
      const next = used + JSON.stringify(request.messages).length;

      if (next > review.budgetChars) {
        spent.delete(key);
        throw new ReviewBudgetExceeded(next, review.budgetChars);
      }

      spent.set(key, next);

      return;
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

      if (!review) {
        return;
      }

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
  return runtime.openAnchored(agent, ReviewAnchor, async (tx, id) => {
    const doc = await tx.doc(ReviewConversation, id);
    doc.executionId = reviewed.id;
    doc.skills = scope.skills;
    doc.memory = scope.memory;
    doc.budgetChars = budgetChars;
  });
}
