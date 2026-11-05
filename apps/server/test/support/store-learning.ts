import {
  MemoryRepository,
  type NewMemory,
} from "../../src/memory/memory-repository";
import { ChangeReverter } from "../../src/learning/change-reverter";
import { LearnedChangeRepository } from "../../src/learned-changes/learned-change-repository";
import { ReviewRepository } from "../../src/learning/review-repository";
import {
  SkillRepository,
  type NewSkill,
  type SkillPatch,
} from "../../src/skills/skill-repository";
import type { ChangeBy } from "../../src/shared/domain";
import type { LearnedChange, Skill } from "../../src/contract/skills";
import type { StoreRun } from "./store";

export const learningStore = (run: StoreRun) => ({
  getMemory: (memoryId: string) => {
    return run(MemoryRepository.use((r) => r.get(memoryId)));
  },
  createMemory: (input: NewMemory, memoryId?: string, by?: ChangeBy | null) => {
    return run(MemoryRepository.use((r) => r.create(input, memoryId, by)));
  },
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
  recordSkillUse: (skillId: string) => {
    run(SkillRepository.use((r) => r.recordUse(skillId)));
  },
  deleteSkill: (skillId: string, by?: ChangeBy | null) => {
    return run(SkillRepository.use((r) => r.delete(skillId, by)));
  },

  reviewCounters: (agentId: string) => {
    return run(ReviewRepository.use((r) => r.counters(agentId)));
  },
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
  listChanges: (
    agentId: string | null | undefined,
    options: { limit?: number | undefined; before?: string | undefined } = {},
  ): LearnedChange[] => {
    return run(LearnedChangeRepository.use((r) => r.list(agentId, options)));
  },
  getChange: (changeId: string) => {
    return run(LearnedChangeRepository.use((r) => r.get(changeId)));
  },
  listChangesOfExecution: (
    executionId: string,
    actor: LearnedChange["actor"],
  ) => {
    return run(
      LearnedChangeRepository.use((r) => r.listOfExecution(executionId, actor)),
    );
  },
  listReviewResults: (agentId: string, limit?: number) => {
    return run(
      LearnedChangeRepository.use((r) => r.listReviewResults(agentId, limit)),
    );
  },
  revertChange: (changeId: string, by: ChangeBy): LearnedChange | null => {
    return run(ChangeReverter.use((r) => r.revert(changeId, by)));
  },
});
