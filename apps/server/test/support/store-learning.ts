import { Effect } from "effect";
import { MemoryRepository } from "../../src/memory/memory-repository";
import type { NewMemory } from "../../src/memory/memory-repository";
import { ChangeReverter } from "../../src/learning/change-reverter";
import { LearnedChangeRepository } from "../../src/learned-changes/learned-change-repository";
import { ReviewRepository } from "../../src/learning/review-repository";
import { SkillRepository } from "../../src/skills/skill-repository";
import type { NewSkill, SkillPatch } from "../../src/skills/skill-repository";
import type { ChangeBy } from "../../src/shared/domain";
import type { LearnedChange, Skill } from "../../src/contract/skills";
import type { StoreRun } from "./store";

const memoryStore = (run: StoreRun) => ({
  getMemory: (memoryId: string) => {
    return run(Effect.flatMap(MemoryRepository, (r) => r.get(memoryId)));
  },
  createMemory: (input: NewMemory, memoryId?: string, by?: ChangeBy | null) => {
    return run(
      Effect.flatMap(MemoryRepository, (r) => r.create(input, memoryId, by)),
    );
  },
});

const skillStore = (run: StoreRun) => ({
  listSkills: (agentId: string | null = null): Array<Skill> => {
    return run(Effect.flatMap(SkillRepository, (r) => r.list(agentId)));
  },
  getSkill: (skillId: string) => {
    return run(Effect.flatMap(SkillRepository, (r) => r.get(skillId)));
  },
  createSkill: (
    input: NewSkill,
    skillId?: string,
    by?: ChangeBy | null,
  ): Skill => {
    return run(
      Effect.flatMap(SkillRepository, (r) => r.create(input, skillId, by)),
    );
  },
  updateSkill: (skillId: string, patch: SkillPatch, by?: ChangeBy | null) => {
    return run(
      Effect.flatMap(SkillRepository, (r) => r.update(skillId, patch, by)),
    );
  },
  recordSkillUse: (skillId: string) => {
    run(Effect.flatMap(SkillRepository, (r) => r.recordUse(skillId)));
  },
  deleteSkill: (skillId: string, by?: ChangeBy | null) => {
    return run(Effect.flatMap(SkillRepository, (r) => r.delete(skillId, by)));
  },
});

const reviewStore = (run: StoreRun) => ({
  reviewCounters: (agentId: string) => {
    return run(Effect.flatMap(ReviewRepository, (r) => r.counters(agentId)));
  },
  listPendingReviews: () => {
    return run(Effect.flatMap(ReviewRepository, (r) => r.listPending));
  },
  addPendingReview: (
    executionId: string,
    agentId: string,
    conversationId: string,
  ) => {
    run(
      Effect.flatMap(ReviewRepository, (r) =>
        r.addPending(executionId, agentId, conversationId),
      ),
    );
  },
});

const learnedChangeStore = (run: StoreRun) => ({
  listChanges: (
    agentId: string | null | undefined,
    options: { limit?: number | undefined; before?: string | undefined } = {},
  ): Array<LearnedChange> => {
    return run(
      Effect.flatMap(LearnedChangeRepository, (r) => r.list(agentId, options)),
    );
  },
  getChange: (changeId: string) => {
    return run(Effect.flatMap(LearnedChangeRepository, (r) => r.get(changeId)));
  },
  listChangesOfExecution: (
    executionId: string,
    actor: LearnedChange["actor"],
  ) => {
    return run(
      Effect.flatMap(LearnedChangeRepository, (r) =>
        r.listOfExecution(executionId, actor),
      ),
    );
  },
  listReviewResults: (agentId: string, limit?: number) => {
    return run(
      Effect.flatMap(LearnedChangeRepository, (r) =>
        r.listReviewResults(agentId, limit),
      ),
    );
  },
  revertChange: (changeId: string, by: ChangeBy): LearnedChange | null => {
    return run(Effect.flatMap(ChangeReverter, (r) => r.revert(changeId, by)));
  },
});

export const learningStore = (run: StoreRun) => ({
  ...memoryStore(run),
  ...skillStore(run),
  ...reviewStore(run),
  ...learnedChangeStore(run),
});
