import { Effect, Layer, ManagedRuntime } from "effect";
import type { AgentRepository } from "../bot-store/agent-repository";
import type { Bots } from "../bots/bots";
import type { BotRuntime } from "../bots/runtime";
import type { Execution } from "../shared/domain";
import type { Runner } from "../shared/runner";
import type { LearnedChangeRepository } from "../learned-changes/learned-change-repository";
import { LearningReview } from "./learning-review";
import type { ReviewRepository } from "./review-repository";

/** Learning reviews over standalone bots, for a test without an account. */
export const standaloneLearningReview = (bots: {
  effects: Runner<Bots | BotRuntime | AgentRepository>;
  store: { runtime: Runner<ReviewRepository | LearnedChangeRepository> };
}) => {
  const runtime = ManagedRuntime.make(
    LearningReview.layer.pipe(
      Layer.provide(
        Layer.succeedContext(
          bots.effects.runSync(
            Effect.context<Bots | BotRuntime | AgentRepository>(),
          ),
        ),
      ),
      Layer.provide(
        Layer.succeedContext(
          bots.store.runtime.runSync(
            Effect.context<ReviewRepository | LearnedChangeRepository>(),
          ),
        ),
      ),
    ),
  );

  return {
    recover: () => runtime.runPromise(LearningReview.use((l) => l.recover)),
    afterExecution: (execution: Execution) =>
      runtime.runPromise(
        LearningReview.use((l) => l.afterExecution(execution)),
      ),
  };
};
