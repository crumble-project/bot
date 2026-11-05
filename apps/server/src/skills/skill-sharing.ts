import { Effect } from "effect";
import { isSqlError } from "effect/sql/SqlError";
import { AgentRepository } from "../bots/agent-repository";
import type { Agent, Skill } from "../shared/domain";
import {
  InvalidInput,
  NotFound,
  ReadOnly,
  type AppError,
} from "../shared/errors";
import { MAX_BOT_SKILLS } from "../shared/limits";
import { ProductDatabase } from "../shared/product-database";
import { SkillRepository } from "./skill-repository";

const tooManySkills = () =>
  new InvalidInput({
    message: `A bot can use at most ${MAX_BOT_SKILLS} shared skills`,
  });

/** Runs `effect` as one transaction: a failure leaves nothing behind. */
const atomic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  ProductDatabase.use((db) =>
    db.transaction(() => effect).pipe(Effect.catchIf(isSqlError, Effect.die)),
  );

/** A shared skill the owner may edit: a skill installed from GitHub follows its upstream instead. */
export const editableSharedSkill = Effect.fnUntraced(function* (
  skillId: string,
) {
  const skill = yield* SkillRepository.use((r) => r.get(skillId));

  if (!skill || skill.agentId)
    return yield* new NotFound({ message: "Skill not found" });

  if (skill.origin)
    return yield* new ReadOnly({
      message: "Installed skills are read-only. Make a copy to change one.",
    });

  return skill;
});

/** Deletes a shared skill and drops it from the bots that had it shared. */
export const removeSharedSkill = (skillId: string) =>
  atomic(
    Effect.gen(function* () {
      const skills = yield* SkillRepository;
      const agents = yield* AgentRepository;
      const skill = yield* skills.get(skillId);

      if (skill?.agentId || !(yield* skills.delete(skillId)))
        return yield* new NotFound({ message: "Skill not found" });

      for (const agent of yield* agents.list) {
        const shared = agent.sharedSkills ?? [];

        if (shared.includes(skillId))
          yield* agents.update(agent.id, {
            sharedSkills: shared.filter((id) => id !== skillId),
          });
      }
    }),
  );

const assignShared = Effect.fnUntraced(function* (
  source: Skill,
  target: Agent,
  assigned: boolean,
) {
  const current = target.sharedSkills ?? [];
  const already = current.includes(source.id);

  if (assigned && !already && current.length >= MAX_BOT_SKILLS)
    return yield* tooManySkills();

  if (assigned !== already)
    yield* AgentRepository.use((r) =>
      r.update(target.id, {
        sharedSkills: (assigned
          ? [...current, source.id]
          : current.filter((id) => id !== source.id)
        ).toSorted(),
      }),
    );

  return assigned === already;
});

/** Only direct linked copies are matched. The source and same-name skills are never removal targets. */
const assignOwn = Effect.fnUntraced(function* (
  source: Skill,
  target: Agent,
  assigned: boolean,
) {
  if (source.agentId === target.id) return true;
  const skills = yield* SkillRepository;

  const copies = (yield* skills.list(target.id)).filter(
    (skill) => skill.copiedFromSkillId === source.id,
  );

  if (assigned && !copies.length)
    yield* skills.create({
      agentId: target.id,
      name: source.name,
      description: source.description,
      instructions: source.instructions,
      documents: source.documents,
      copiedFromSkillId: source.id,
    });

  if (!assigned) for (const copy of copies) yield* skills.delete(copy.id);

  return assigned ? copies.length > 0 : copies.length === 0;
});

/** Gives `target` the skill: a shared one is linked, a bot's own is copied. Returns true when it already had it. */
export const assignSkill = (
  source: Skill,
  target: Agent,
  assigned: boolean,
): Effect.Effect<boolean, AppError, AgentRepository | SkillRepository> =>
  source.agentId
    ? assignOwn(source, target, assigned)
    : assignShared(source, target, assigned);

/** Adds `skillIds` to each bot's shared skills: all of them, or none when one bot would go over the limit. */
export const shareWith = (botIds: string[], skillIds: string[]) =>
  atomic(
    Effect.gen(function* () {
      const agents = yield* AgentRepository;

      for (const botId of botIds) {
        const agent = yield* agents.get(botId);

        if (!agent) continue;

        const sharedSkills = [
          ...new Set([...(agent.sharedSkills ?? []), ...skillIds]),
        ].toSorted();

        if (sharedSkills.length > MAX_BOT_SKILLS) return yield* tooManySkills();

        yield* agents.update(agent.id, { sharedSkills });
      }
    }),
  );
