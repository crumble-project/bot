import {
  Cause,
  Clock,
  Context,
  Effect,
  Layer,
  Schedule as Cadence,
} from "effect";
import type { Skill } from "../shared/domain";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { SkillRepository } from "./skill-repository";
import type { Runner } from "../shared/runner";

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
export class SkillCurator extends Context.Service<
  SkillCurator,
  {
    /** Moves each idle skill one state on, as of `now`, and reports what it moved. */
    readonly pass: (now: Date) => Effect.Effect<CuratorAction[]>;
  }
>()("crumble/skills/SkillCurator") {
  static readonly make = Effect.gen(function* () {
    const skills = yield* SkillRepository;
    const schedules = yield* ScheduleRepository;

    /** Whether a scheduled task's prompt names the skill, so a slow schedule cannot lose it. */
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

          // An active skill's edits and its restoration count as activity; a stale one is measured from its last
          // use, since the curator's own transition updated it.
          const lastActivity = Math.max(
            Date.parse(skill.lastUsedAt ?? skill.createdAt),
            skill.state === "active" ? Date.parse(skill.updatedAt) : 0,
          );

          const idleDays = (now.getTime() - lastActivity) / DAY;

          if (idleDays < STALE_AFTER_DAYS) continue;

          if (yield* namedByTask(skill)) continue;

          // Idle time counts from creation for a skill that was never used, so it gets the full periods to be.
          const to: Skill["state"] =
            idleDays >= ARCHIVE_AFTER_DAYS ? "archived" : "stale";

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
  });

  static readonly layer = Layer.effect(SkillCurator, SkillCurator.make);
}

/** One curation pass over `store`'s account as of `now`, for a test without an account. */
export const curateNow = (
  store: { runtime: Runner<SkillRepository | ScheduleRepository> },
  now: Date,
) =>
  store.runtime.runSync(
    SkillCurator.make.pipe(Effect.flatMap((curator) => curator.pass(now))),
  );

/** Curates now and then every six hours, until the layer's scope closes. */
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
