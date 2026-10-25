import type { Skill } from "../shared/domain";
import type { Store } from "../shared/store";

const DAY = 24 * 60 * 60 * 1000;

export const STALE_AFTER_DAYS = 14;
export const ARCHIVE_AFTER_DAYS = 30;
const PASS_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type CuratorAction = {
  skillId: string;
  agentId: string | null;
  name: string;
  from: Skill["state"];
  to: Skill["state"];
};

/**
 * Keeps bot-created skills from piling up: unused ones go stale, then into the archive, never into the bin. Pinned
 * skills and skills a scheduled task names are left alone, and a skill that was never used gets the stale period
 * to be, since zero uses is absence of evidence.
 */
export class SkillCurator {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly store: Store) {}

  /** Runs one pass now and then every six hours. */
  start() {
    void this.pass();
    this.timer = setInterval(() => void this.pass(), PASS_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Whether a scheduled task's prompt names the skill, so a slow schedule cannot lose it. */
  private namedByTask(skill: Skill) {
    const name = skill.name.toLowerCase();

    return this.store
      .listSchedules(skill.agentId ?? undefined)
      .some((schedule) => schedule.prompt.toLowerCase().includes(name));
  }

  pass(now = new Date()): CuratorAction[] {
    const actions: CuratorAction[] = [];

    for (const skill of this.store.listBotCreatedSkills()) {
      if (skill.pinned || skill.state === "archived") continue;

      // An active skill's edits and its restoration count as activity; a stale one is measured from its last use,
      // since the curator's own transition updated it.
      const lastActivity = Math.max(
        Date.parse(skill.lastUsedAt ?? skill.createdAt),
        skill.state === "active" ? Date.parse(skill.updatedAt) : 0,
      );

      const idleDays = (now.getTime() - lastActivity) / DAY;

      if (idleDays < STALE_AFTER_DAYS) continue;

      if (this.namedByTask(skill)) continue;

      // Idle time counts from creation for a skill that was never used, so it gets the full periods to be.
      const to: Skill["state"] =
        idleDays >= ARCHIVE_AFTER_DAYS ? "archived" : "stale";

      if (to === skill.state) continue;
      this.store.updateSkill(skill.id, { state: to }, { actor: "curator" });

      actions.push({
        skillId: skill.id,
        agentId: skill.agentId,
        name: skill.name,
        from: skill.state,
        to,
      });
    }

    return actions;
  }
}
