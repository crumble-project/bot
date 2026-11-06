import { Layer, ManagedRuntime } from "effect";
import type { AgentRepository } from "../bot-store/agent-repository";
import type { Bots } from "../bots/bots";
import type { BotRuntime } from "../bots/runtime";
import type { Execution } from "../shared/domain";
import { layerOfRunner, type Runner } from "../shared/runner";
import type { LearnedChangeRepository } from "../learned-changes/learned-change-repository";
import { LearningReview } from "./learning-review";
import type { ReviewRepository } from "./review-repository";

export const standaloneLearningReview = (bots: {
  effects: Runner<Bots | BotRuntime | AgentRepository>;
  store: { runtime: Runner<ReviewRepository | LearnedChangeRepository> };
}) => {
  const runtime = ManagedRuntime.make(
    LearningReview.layer.pipe(
      Layer.provide(layerOfRunner(bots.effects)),
      Layer.provide(layerOfRunner(bots.store.runtime)),
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
