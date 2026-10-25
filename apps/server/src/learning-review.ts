import type { Execution, LearnedChange, Memory, Skill } from "./domain";
import type { AgentRuntime } from "./runtime";
import { GROUP_TURN_PREFIX, type LearnedActivity } from "./service";
import type { Store } from "./store";

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
export class LearningReview {
  private readonly running = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly runtime: AgentRuntime,
    private readonly announce: (event: LearnedActivity) => void,
  ) {}

  /** A review interrupted by a restart is dropped: its conversation is aborted and forgotten. */
  async recover() {
    for (const pending of this.store.listPendingReviews()) {
      const agent = this.store.getAgent(pending.agentId);

      if (agent)
        await this.runtime
          .abort(agent, pending.conversationId)
          .catch((error) =>
            console.error(
              "Dropping a pending review failed",
              pending.executionId,
              error,
            ),
          );
      this.store.removePendingReview(pending.executionId);
    }
  }

  /** Counts the turn's tool activity and runs a review when a counter reaches its threshold. */
  async afterExecution(execution: Execution) {
    if (
      execution.status !== "done" ||
      execution.scheduleId ||
      isGroupTurn(execution) ||
      !execution.submissionId ||
      this.running.has(execution.id)
    )
      return;
    const agent = this.store.getAgent(execution.agentId);
    const settings = { ...DEFAULTS, ...agent?.review };

    if (!agent?.enabled || !settings.enabled) return;
    this.running.add(execution.id);

    try {
      const budgetChars = await this.runtime.reviewBudgetChars(agent);

      // The digest may take at most half the budget; the rest pays for the review's own requests.
      const report = await this.runtime.turnReport(
        agent,
        execution.conversationId,
        execution.submissionId,
        Math.floor(budgetChars / 2),
      );

      // A write inside the turn restarts that store's count; only rounds after it count towards the next review.
      if (report.roundsSinceSkillWrite !== null)
        this.store.setReviewCounter(
          agent.id,
          "skill",
          report.roundsSinceSkillWrite,
        );

      if (report.roundsSinceMemoryWrite !== null)
        this.store.setReviewCounter(
          agent.id,
          "memory",
          report.roundsSinceMemoryWrite,
        );

      const counters = this.store.addReviewRounds(
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

      if (scope.skills) this.store.setReviewCounter(agent.id, "skill", 0);

      if (scope.memory) this.store.setReviewCounter(agent.id, "memory", 0);

      const conversation = await this.runtime.openReviewConversation(
        agent,
        execution.id,
        scope,
        budgetChars,
      );

      this.store.addPendingReview(execution.id, agent.id, conversation);

      try {
        const submission = await this.runtime.submit(
          agent,
          conversation,
          report.digest || "(The turn left no readable digest.)",
          `review:${execution.id}`,
          { origin: { kind: "review" } },
        );

        await this.runtime.wait(submission, agent);
      } finally {
        this.store.removePendingReview(execution.id);
      }

      const changes = this.store.listChangesOfExecution(execution.id, "review");

      if (!changes.length) return;

      this.store.addReviewResult(
        execution.id,
        agent.id,
        changes.map((change) => change.id),
      );

      this.announce({
        type: "learned",
        agentId: agent.id,
        agentName: agent.name,
        executionId: execution.id,
        changes: changes.map((change) => ({
          changeId: change.id,
          target: change.target,
          action: change.action,
          name: nameOf(change),
        })),
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Learning review failed", execution.id, error);
    } finally {
      this.running.delete(execution.id);
    }
  }
}
