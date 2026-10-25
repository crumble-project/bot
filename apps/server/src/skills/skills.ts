import type { CommonSkill } from "./common-skills";
import type { Agent, ChangeBy, SkillInput } from "../shared/domain";
import { changeSourceOf } from "../memory/memory-sources";
import type {
  AvailableSkill,
  SkillLibrary,
  SkillToolContext,
} from "./skill-library";
import type { Store } from "../shared/store";

/** The skill library over the product database and the repository's default skills. */
export function skillLibrary(
  store: Store,
  commonSkills: CommonSkill[],
): SkillLibrary {
  const by = (agentId: string, context: SkillToolContext): ChangeBy =>
    context.reviewOf
      ? { actor: "review", source: { executionId: context.reviewOf } }
      : { actor: "bot", source: changeSourceOf(store, agentId, context) };

  const own = (agentId: string) =>
    store.listSkills(agentId).filter((skill) => skill.state !== "archived");

  const ownedBy = (skillId: string) => {
    const skill = store.getSkill(skillId);

    if (!skill?.agentId) throw new Error("Skill not found");

    return skill;
  };

  return {
    available(agent: Agent): AvailableSkill[] {
      return [
        ...commonSkills.map((skill) => ({
          ...skill,
          description: skill.description ?? "",
          scope: "default" as const,
        })),
        ...(agent.sharedSkills ?? []).flatMap((id) => {
          const skill = store.getSkill(id);

          return skill && skill.agentId === null && skill.state !== "archived"
            ? [{ ...skill, scope: "shared" as const }]
            : [];
        }),
        ...own(agent.id).map((skill) => ({ ...skill, scope: "own" as const })),
      ];
    },
    used(_agent, skill) {
      if (skill.scope !== "default") store.recordSkillUse(skill.id);
    },
    own,
    create(agentId, input: SkillInput, context) {
      return store.createSkill(
        {
          ...input,
          agentId,
          createdBy: "bot",
          sourceExecutionId:
            context.reviewOf ??
            changeSourceOf(store, agentId, context).executionId ??
            null,
        },
        undefined,
        by(agentId, context),
      );
    },
    update(skillId, patch, context) {
      const skill = ownedBy(skillId);

      return store.updateSkill(skill.id, patch, by(skill.agentId!, context))!;
    },
    remove(skillId, context) {
      const skill = ownedBy(skillId);
      store.deleteSkill(skill.id, by(skill.agentId!, context));
    },
    transaction: (fn) => store.transaction(fn),
  };
}
