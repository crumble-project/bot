import { Cause, Context, Effect, FiberSet, Layer } from "effect";
import type {
  Agent,
  Execution,
  LearnedChange,
  Memory,
  Skill,
} from "../shared/domain";
import type { Runner } from "../shared/runner";
import { AgentRepository } from "../bots/agent-repository";
import { BotRuntime } from "../bots/runtime";
import { Bots, GROUP_TURN_PREFIX } from "../bots/bots";
import { LearnedChangeRepository } from "./learned-change-repository";
import { ReviewRepository } from "./review-repository";

/** Which stores one review may change. */
export type ReviewScope = { skills: boolean; memory: boolean };

const DEFAULTS = { enabled: true, skillThreshold: 10, memoryThreshold: 10 };

/**
 * The review prompt, adapted from Hermes Agent's background review: skills carry how to do a class of task for this
 * owner, memory the facts that hold in every conversation. The turn to review arrives as the input.
 */
export function reviewInstructions(scope: ReviewScope) {
  const parts = [
    "You are reviewing one of your own finished turns, given below as a digest, to improve what you know for next time. This conversation is not the owner's chat: nothing you write here is shown to them as a reply, and your only means of acting are the tools offered. Say 'Nothing to save.' and stop when the turn ran smoothly, taught nothing, and the owner corrected nothing; otherwise act, then end with one line naming what you changed.",
  ];

  if (scope.skills)
    parts.push(
      "Skills: a skill is the instructions for doing a class of task the most efficient and correct way, to this owner's specifications: the procedure in order, the tools and commands that work, how the result should look, and the pitfalls that cost time. Signals that warrant a skill update: the owner corrected your style, format, verbosity, workflow, or approach; a non-trivial technique, fix, workaround, or tool-usage pattern emerged; a skill you loaded turned out wrong, incomplete, or outdated. Prefer the smallest change that fits, in this order: patch the skill that was loaded during the turn; patch an existing skill that covers the class of task; add a reference document under references/ named by topic; only then create a new skill named at the class of task, never after today's task, an error string, or a date. Load a skill with the skill tool here before patching it; writes must follow a current read. A pitfall is a general rule plus one clause of why, attached to the step it affects, stated once; fix a wrong sentence in place instead of appending a correction. Do not record: environment-dependent failures such as missing programs or credentials; negative claims about tools being broken; transient errors that a retry fixed; one-off tasks; dead ends from work that did not reach a working method. Never delete a skill; mention overlap in your reply instead.",
    );

  if (scope.memory)
    parts.push(
      "Memory: save only facts that hold in every conversation regardless of task, such as who the owner is, standing conventions, and environment facts with no task home. Write them as declarative facts, not instructions to yourself, once, and consolidate stale entries instead of adding duplicates. Task-specific lessons belong in skills, not memory.",
    );

  return parts.join("\n\n");
}

const isGroupTurn = (execution: Execution) =>
  execution.requestId.startsWith(GROUP_TURN_PREFIX);

const nameOf = (change: LearnedChange) => {
  // SAFETY: a change's states have the shape of its target, written by the store that recorded them.
  const state = (change.after ?? change.before) as Skill | Memory | null;

  if (!state) return change.targetId;

  return "name" in state ? state.name : state.content.slice(0, 80);
};

/** Reviews a bot's settled bot-chat turns in the background and reports what they changed. */
export class LearningReview extends Context.Service<
  LearningReview,
  {
    /** A review interrupted by a restart is dropped: its conversation is aborted and forgotten. */
    readonly recover: Effect.Effect<void>;
    /** Counts the turn's tool activity and runs a review when a counter reaches its threshold. */
    readonly afterExecution: (execution: Execution) => Effect.Effect<void>;
  }
>()("crumble/skills/LearningReview") {
  static readonly make = Effect.gen(function* () {
    const agents = yield* AgentRepository;
    const reviews = yield* ReviewRepository;
    const changes = yield* LearnedChangeRepository;
    const runtime = yield* BotRuntime;
    const bots = yield* Bots;
    const running = new Set<string>();

    const pi = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (error) => error });

    const review = Effect.fnUntraced(function* (
      execution: Execution,
      submissionId: string,
      agent: Agent,
      settings: typeof DEFAULTS,
    ) {
      const budgetChars = yield* pi(() => runtime.reviewBudgetChars(agent));

      // The digest may take at most half the budget; the rest pays for the review's own requests.
      const report = yield* pi(() =>
        runtime.turnReport(
          agent,
          execution.conversationId,
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
          agent.tools.includes("memory"),
      };

      if (!scope.skills && !scope.memory) return;

      if (scope.skills) yield* reviews.setCounter(agent.id, "skill", 0);

      if (scope.memory) yield* reviews.setCounter(agent.id, "memory", 0);

      const conversation = yield* pi(() =>
        runtime.openReviewConversation(agent, execution.id, scope, budgetChars),
      );

      yield* reviews.addPending(execution.id, agent.id, conversation);

      yield* Effect.gen(function* () {
        const submission = yield* pi(() =>
          runtime.submit(
            agent,
            conversation,
            report.digest || "(The turn left no readable digest.)",
            `review:${execution.id}`,
            { origin: { kind: "review" } },
          ),
        );

        yield* pi(() => runtime.wait(submission, agent));
      }).pipe(Effect.ensuring(reviews.removePending(execution.id)));

      const made = yield* changes.listOfExecution(execution.id, "review");

      if (!made.length) return;

      yield* changes.addReviewResult(
        execution.id,
        agent.id,
        made.map((change) => change.id),
      );

      yield* bots.announce({
        type: "learned",
        agentId: agent.id,
        agentName: agent.name,
        executionId: execution.id,
        changes: made.map((change) => ({
          changeId: change.id,
          target: change.target,
          action: change.action,
          name: nameOf(change),
        })),
        createdAt: new Date().toISOString(),
      });
    });

    return LearningReview.of({
      recover: Effect.gen(function* () {
        for (const pending of yield* reviews.listPending) {
          const agent = yield* agents.get(pending.agentId);

          if (agent)
            yield* pi(() => runtime.abort(agent, pending.conversationId)).pipe(
              Effect.catch((error) =>
                Effect.logError(
                  "Dropping a pending review failed",
                  pending.executionId,
                  error,
                ),
              ),
            );
          yield* reviews.removePending(pending.executionId);
        }
      }),
      afterExecution: Effect.fn("LearningReview.afterExecution")(function* (
        execution: Execution,
      ) {
        const { submissionId } = execution;

        if (
          execution.status !== "done" ||
          execution.scheduleId ||
          isGroupTurn(execution) ||
          !submissionId ||
          running.has(execution.id)
        )
          return;
        const agent = yield* agents.get(execution.agentId);
        const settings = { ...DEFAULTS, ...agent?.review };

        if (!agent?.enabled || !settings.enabled) return;
        running.add(execution.id);

        yield* review(execution, submissionId, agent, settings).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(
              "Learning review failed",
              execution.id,
              Cause.squash(cause),
            ),
          ),
          Effect.ensuring(Effect.sync(() => running.delete(execution.id))),
        );
      }),
    });
  });

  static readonly layer = Layer.effect(LearningReview, LearningReview.make);
}

/** Drops the reviews a restart interrupted, then reviews each settled bot-chat turn until the layer's scope closes. */
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
  }),
);

/** Learning reviews over standalone bots, for a test without an account. */
export const standaloneLearningReview = (bots: {
  effects: Runner<Bots | BotRuntime | AgentRepository>;
  store: { runtime: Runner<ReviewRepository | LearnedChangeRepository> };
}) => {
  const learning = Effect.runSync(
    LearningReview.make.pipe(
      Effect.provideContext(
        Context.merge(
          bots.effects.runSync(
            Effect.context<Bots | BotRuntime | AgentRepository>(),
          ),
          bots.store.runtime.runSync(
            Effect.context<ReviewRepository | LearnedChangeRepository>(),
          ),
        ),
      ),
    ),
  );

  return {
    recover: () => Effect.runPromise(learning.recover),
    afterExecution: (execution: Execution) =>
      Effect.runPromise(learning.afterExecution(execution)),
  };
};
