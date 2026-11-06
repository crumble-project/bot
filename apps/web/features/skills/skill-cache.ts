import { queryClient } from "@/lib/api";
import { botSkillsKey, skillsQuery } from "./api";
import { invalidateBots } from "@/features/bots/api";

export const skillKey = (skillId: string) => ["skill", skillId];

export const skillUpdateKey = (skillId: string) => ["skill-update", skillId];

export async function invalidateSkills() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: skillsQuery.queryKey }),
    invalidateBots(),
    queryClient.invalidateQueries({ queryKey: botSkillsKey }),
  ]);
}

export async function invalidateSkill(skillId: string) {
  await Promise.all([
    invalidateSkills(),
    queryClient.invalidateQueries({ queryKey: skillKey(skillId) }),
    queryClient.invalidateQueries({ queryKey: skillUpdateKey(skillId) }),
  ]);
}
