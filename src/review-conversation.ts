import {
  defineDoc,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";

export const REVIEW_EXTENSION = "learning-review";

/**
 * Marks a bot's conversation as the review of one execution: what it may write, which stores it reviews, and how
 * many characters of model input the whole review may spend.
 */
export const ReviewConversation = defineDoc<{
  executionId: string | null;
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
    skills: false,
    memory: false,
    budgetChars: 0,
  }),
});

// Owns a review conversation, so it stays out of the bot chat transcript, like a group conversation's anchor.
export const ReviewAnchor = defineTask<null, { phase: "done" }, null>({
  name: "crumble.review-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, taskContext) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: null },
        }),
        taskContext,
      ),
  },
  abort: (_anchor, runtime, taskContext) =>
    runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      taskContext,
    ),
});

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
export function reviewExtension() {
  const spent = new Map<string, number>();

  const budget = hook(GenerationTask, {
    beforeRequest: async (request, api, context) => {
      const review = await api.snapshot(
        ReviewConversation,
        api.conversationId,
        context,
      );

      if (!review?.executionId || !review.budgetChars) return undefined;
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
