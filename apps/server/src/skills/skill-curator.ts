import {
  Cause,
  Clock,
  Context,
  Effect,
  Layer,
  Schedule as Cadence,
} from "effect";
import type { Skill } from "../contract/skills";
import { ScheduleRepository } from "../automations/schedule-repository";
import { SkillRepository } from "./skill-repository";

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

function idleDays(skill: Skill, now: Date): number {
  // An active skill's edits and restoration count as activity; a stale one's
  // transition updated it, so measure that state from its last use instead.
  const lastActivity = Math.max(
    Date.parse(skill.lastUsedAt ?? skill.createdAt),
    skill.state === "active" ? Date.parse(skill.updatedAt) : 0,
  );

  return (now.getTime() - lastActivity) / DAY;
}

export class SkillCurator extends Context.Service<
  SkillCurator,
  {
    readonly pass: (now: Date) => Effect.Effect<CuratorAction[]>;
  }
>()("crumble/skills/SkillCurator") {
  static readonly layer = Layer.effect(
    SkillCurator,
    Effect.gen(function* () {
      const skills = yield* SkillRepository;
      const schedules = yield* ScheduleRepository;

      const namedByTask = (skill: Skill) => {
        const name = skill.name.toLowerCase();

        return schedules
          .list(skill.agentId ?? undefined)
          .pipe(
            Effect.map((list) =>
              list.some((schedule) =>
                schedule.prompt.toLowerCase().includes(name),
              ),
            ),
          );
      };

      return SkillCurator.of({
        pass: Effect.fn("SkillCurator.pass")(function* (now: Date) {
          const actions: CuratorAction[] = [];

          for (const skill of yield* skills.listBotCreated) {
            if (skill.pinned || skill.state === "archived") continue;

            const days = idleDays(skill, now);

            if (days < STALE_AFTER_DAYS) continue;

            if (yield* namedByTask(skill)) continue;

            const to: Skill["state"] =
              days >= ARCHIVE_AFTER_DAYS ? "archived" : "stale";

            if (to === skill.state) continue;
            yield* skills.update(skill.id, { state: to }, { actor: "curator" });

            actions.push({
              skillId: skill.id,
              agentId: skill.agentId,
              name: skill.name,
              from: skill.state,
              to,
            });
          }

          return actions;
        }),
      });
    }),
  );
}

export const skillCuration = Layer.effectDiscard(
  Effect.gen(function* () {
    const curator = yield* SkillCurator;

    yield* Clock.currentTimeMillis.pipe(
      Effect.flatMap((millis) => curator.pass(new Date(millis))),
      Effect.catchCause((cause) =>
        Effect.logError("Skill curation failed", Cause.squash(cause)),
      ),
      Effect.repeat(Cadence.spaced(PASS_INTERVAL_MS)),
      Effect.forkScoped,
    );
  }),
);
