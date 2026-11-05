import { jobTurnId, reviewRequest } from "../shared/request-ids";
import { Context, Effect, FiberSet, Layer } from "effect";
import type { Agent } from "../contract/agents";
import type { Execution, Memory } from "../shared/domain";
import type { LearnedChange, Skill } from "../contract/skills";
import { AgentRepository } from "../bots/agent-repository";
import { BotRuntime } from "../bots/runtime";
import { Bots } from "../bots/bots";
import { pluginJobKinds, Plugins } from "../plugins/plugins";
import type { JobFinished } from "../jobs/jobs";
import { logged, pi } from "../shared/app-errors";
import { formatEntryId } from "../shared/entry-ids";
import { nowIso } from "../shared/time";
import { LearnedChangeRepository } from "./learned-change-repository";
import { ReviewRepository } from "./review-repository";
import { openReviewConversation, reviewModelOf } from "./review-conversation";
import type { ReviewScope } from "./review-instructions";
import { reviewBudgetChars, turnReport } from "./turn-report";
import { BOT_TOOL } from "../contract/tools";
import { DEFAULT_REVIEW_THRESHOLD } from "../shared/limits";

const DEFAULTS = {
  enabled: true,
  skillThreshold: DEFAULT_REVIEW_THRESHOLD,
  memoryThreshold: DEFAULT_REVIEW_THRESHOLD,
};

const nameOf = (change: LearnedChange) => {
  // SAFETY: a change's states have the shape of its target, written by the store that recorded them.
  const state = (change.after ?? change.before) as Skill | Memory | null;

  if (!state) return change.targetId;

  return "name" in state ? state.name : state.content.slice(0, 80);
};

/** Reviews a bot's settled turns in the background and reports what they changed. */
export class LearningReview extends Context.Service<
  LearningReview,
  {
    /** A review interrupted by a restart is dropped: its conversation is aborted and forgotten. */
    readonly recover: Effect.Effect<void>;
    /** Counts the turn's tool activity and runs a review when a counter reaches its threshold. */
    readonly afterExecution: (execution: Execution) => Effect.Effect<void>;
    /** The same for a coding job's turn: what it learned about a repository becomes the bot's skills. */
    readonly afterJob: (finished: JobFinished) => Effect.Effect<void>;
  }
>()("crumble/learning/LearningReview") {
  static readonly layer = Layer.effect(
    LearningReview,
    Effect.gen(function* () {
      const agents = yield* AgentRepository;
      const reviews = yield* ReviewRepository;
      const changes = yield* LearnedChangeRepository;
      const runtime = yield* BotRuntime;
      const bots = yield* Bots;
      const running = new Set<string>();

      // A reviewed turn: an execution, or a coding job's turn under the ID `jobTurnId` gives it.
      const review = Effect.fnUntraced(function* (
        turn: { id: string; conversationId: string },
        submissionId: string,
        agent: Agent,
        settings: typeof DEFAULTS,
      ) {
        const budgetChars = reviewBudgetChars(
          yield* pi(() => runtime.contextWindow(agent, reviewModelOf(agent))),
          agent,
        );

        // The digest may take at most half the budget; the rest pays for the review's own requests.
        const report = yield* pi(() =>
          turnReport(
            runtime,
            agent,
            turn.conversationId,
            submissionId,
            Math.floor(budgetChars / 2),
          ),
        );

        // A write inside the turn restarts that store's count; only rounds after it count towards the next review.
        if (report.roundsSinceSkillWrite !== null)
          yield* reviews.setCounter(
            agent.id,
            "skill",
            report.roundsSinceSkillWrite,
          );

        if (report.roundsSinceMemoryWrite !== null)
          yield* reviews.setCounter(
            agent.id,
            "memory",
            report.roundsSinceMemoryWrite,
          );

        const counters = yield* reviews.addRounds(
          agent.id,
          report.roundsSinceSkillWrite === null ? report.rounds : 0,
          report.roundsSinceMemoryWrite === null ? report.rounds : 0,
        );

        const scope: ReviewScope = {
          skills: counters.skill >= settings.skillThreshold,
          memory:
            counters.memory >= settings.memoryThreshold &&
            agent.tools.includes(BOT_TOOL.memory),
        };

        if (!scope.skills && !scope.memory) return;

        if (scope.skills) yield* reviews.setCounter(agent.id, "skill", 0);

        if (scope.memory) yield* reviews.setCounter(agent.id, "memory", 0);

        const conversation = yield* pi(() =>
          openReviewConversation(runtime, agent, turn, scope, budgetChars),
        );

        yield* reviews.addPending(turn.id, agent.id, conversation);

        yield* Effect.gen(function* () {
          const submission = yield* pi(() =>
            runtime.submit(
              agent,
              conversation,
              report.digest || "(The turn left no readable digest.)",
              reviewRequest(turn.id),
              { origin: { kind: "review" } },
            ),
          );

          yield* pi(() => runtime.wait(submission, agent));
        }).pipe(Effect.ensuring(reviews.removePending(turn.id)));

        const made = yield* changes.listOfExecution(turn.id, "review");

        if (!made.length) return;

        yield* changes.addReviewResult(
          turn.id,
          agent.id,
          made.map((change) => change.id),
        );

        yield* bots.announce({
          type: "learned",
          agentId: agent.id,
          agentName: agent.name,
          executionId: turn.id,
          changes: made.map((change) => ({
            changeId: change.id,
            target: change.target,
            action: change.action,
            name: nameOf(change),
          })),
          createdAt: yield* nowIso,
        });
      });

      const reviewOnce = Effect.fnUntraced(function* (
        turn: { id: string; conversationId: string },
        submissionId: string,
        agentId: string,
      ) {
        if (running.has(turn.id)) return;
        const agent = yield* agents.get(agentId);
        const settings = { ...DEFAULTS, ...agent?.review };

        if (!agent?.enabled || !settings.enabled) return;
        running.add(turn.id);

        yield* review(turn, submissionId, agent, settings).pipe(
          logged("Learning review failed", turn.id),
          Effect.ensuring(Effect.sync(() => running.delete(turn.id))),
        );
      });

      return LearningReview.of({
        recover: Effect.gen(function* () {
          for (const pending of yield* reviews.listPending) {
            const agent = yield* agents.get(pending.agentId);

            if (agent)
              yield* pi(() =>
                runtime.abort(agent, pending.conversationId),
              ).pipe(
                logged("Dropping a pending review failed", pending.executionId),
              );
            yield* reviews.removePending(pending.executionId);
          }
        }),
        afterExecution: Effect.fn("LearningReview.afterExecution")(function* (
          execution: Execution,
        ) {
          const { submissionId } = execution;

          // Scheduled runs, event automations and group turns count too: the bot works in its workspace in all of them.
          if (execution.status === "done" && submissionId)
            yield* reviewOnce(execution, submissionId, execution.agentId);
        }),
        afterJob: Effect.fn("LearningReview.afterJob")(function* (
          finished: JobFinished,
        ) {
          yield* reviewOnce(
            {
              id: jobTurnId(
                finished.kind,
                finished.agentId,
                String(finished.conversationId),
                finished.submissionId,
              ),
              conversationId: formatEntryId(
                finished.agentId,
                Number(finished.conversationId),
              ),
            },
            finished.submissionId,
            finished.agentId,
          );
        }),
      });
    }),
  );
}

/** Drops the reviews a restart interrupted, then reviews each settled turn until the layer's scope closes. */
export const learningReviews = Layer.effectDiscard(
  Effect.gen(function* () {
    const learning = yield* LearningReview;
    const bots = yield* Bots;
    const background = yield* FiberSet.make();
    const fork = yield* FiberSet.runtime(background)<never>();

    yield* learning.recover;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        bots.onSettled((execution) => {
          fork(learning.afterExecution(execution));
        }),
      ),
      (stop) => Effect.sync(stop),
    );
    const jobKinds = pluginJobKinds(yield* Plugins);

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        jobKinds.flatMap(
          (kind) =>
            kind.onFinished?.((finished) => {
              fork(learning.afterJob(finished));
            }) ?? [],
        ),
      ),
      (stops) =>
        Effect.sync(() => {
          for (const stop of stops) stop();
        }),
    );
  }),
);
