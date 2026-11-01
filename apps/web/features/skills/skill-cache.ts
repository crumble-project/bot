import { botsQuery, queryClient, skillsQuery } from "@/lib/api";

export const personalSkillsKey = ["personal-skills"];

/** One shared skill's full package. */
export const skillKey = (skillId: string) => ["skill", skillId];

/** The upstream version an installed skill would update to. */
export const skillUpdateKey = (skillId: string) => ["skill-update", skillId];

/** Refetches every skill list and the bots, whose shared skills a change may touch. */
export async function invalidateSkills() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: skillsQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: botsQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: personalSkillsKey }),
  ]);
}

/** Refetches the lists and one skill's cached package and pending update. */
export async function invalidateSkill(skillId: string) {
  await Promise.all([
    invalidateSkills(),
    queryClient.invalidateQueries({ queryKey: skillKey(skillId) }),
    queryClient.invalidateQueries({ queryKey: skillUpdateKey(skillId) }),
  ]);
}
