import {
  MemoryRepository,
  type NewMemory,
} from "../../src/memory/memory-repository";
import { ChangeReverter } from "../../src/skills/change-reverter";
import { LearnedChangeRepository } from "../../src/skills/learned-change-repository";
import { ReviewRepository } from "../../src/skills/review-repository";
import {
  SkillRepository,
  type NewSkill,
  type SkillPatch,
} from "../../src/skills/skill-repository";
import type { ChangeBy, LearnedChange, Skill } from "../../src/shared/domain";
import type { StoreRun } from "./store";

export const learningStore = (run: StoreRun) => ({
  /** One bot's memories, or the shared ones for `null`. */
  getMemory: (memoryId: string) => {
    return run(MemoryRepository.use((r) => r.get(memoryId)));
  },
  createMemory: (input: NewMemory, memoryId?: string, by?: ChangeBy | null) => {
    return run(MemoryRepository.use((r) => r.create(input, memoryId, by)));
  },
  /** One bot's skills, or the shared ones for `null`, oldest first. */
  listSkills: (agentId: string | null = null): Skill[] => {
    return run(SkillRepository.use((r) => r.list(agentId)));
  },
  getSkill: (skillId: string) => {
    return run(SkillRepository.use((r) => r.get(skillId)));
  },
  createSkill: (
    input: NewSkill,
    skillId?: string,
    by?: ChangeBy | null,
  ): Skill => {
    return run(SkillRepository.use((r) => r.create(input, skillId, by)));
  },
  updateSkill: (skillId: string, patch: SkillPatch, by?: ChangeBy | null) => {
    return run(SkillRepository.use((r) => r.update(skillId, patch, by)));
  },
  /** Loading a skill counts as using it, and brings a stale skill back to active. */
  recordSkillUse: (skillId: string) => {
    run(SkillRepository.use((r) => r.recordUse(skillId)));
  },
  /** Bot-created skills across every bot, for the curator. */
  deleteSkill: (skillId: string, by?: ChangeBy | null) => {
    return run(SkillRepository.use((r) => r.delete(skillId, by)));
  },

  /** Adds a turn's tool-activity rounds to the bot's review counters and returns the totals. */
  reviewCounters: (agentId: string) => {
    return run(ReviewRepository.use((r) => r.counters(agentId)));
  },
  /** Sets one counter: zero after a review fired, or the rounds after a turn's last write to that store. */
  /** Reviews in flight; a server restart drops them instead of resuming. */
  listPendingReviews: () => {
    return run(ReviewRepository.use((r) => r.listPending));
  },
  addPendingReview: (
    executionId: string,
    agentId: string,
    conversationId: string,
  ) => {
    run(
      ReviewRepository.use((r) =>
        r.addPending(executionId, agentId, conversationId),
      ),
    );
  },
  /** Newest changes first: one bot's, the shared ones for `null`, or every change when `agentId` is undefined. */
  listChanges: (
    agentId: string | null | undefined,
    options: { limit?: number | undefined; before?: string | undefined } = {},
  ): LearnedChange[] => {
    return run(LearnedChangeRepository.use((r) => r.list(agentId, options)));
  },
  getChange: (changeId: string) => {
    return run(LearnedChangeRepository.use((r) => r.get(changeId)));
  },
  /** The changes one execution's review made, oldest first. */
  listChangesOfExecution: (
    executionId: string,
    actor: LearnedChange["actor"],
  ) => {
    return run(
      LearnedChangeRepository.use((r) => r.listOfExecution(executionId, actor)),
    );
  },
  /** What a review of one execution changed, kept so clients can show it after the fact. */
  listReviewResults: (agentId: string, limit?: number) => {
    return run(
      LearnedChangeRepository.use((r) => r.listReviewResults(agentId, limit)),
    );
  },
  /** Restores the state before `changeId`, recording the revert as a change of its own. */
  revertChange: (changeId: string, by: ChangeBy): LearnedChange | null => {
    return run(ChangeReverter.use((r) => r.revert(changeId, by)));
  },
});
