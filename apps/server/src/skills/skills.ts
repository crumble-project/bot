import { Context, Effect, Layer } from "effect";
import type { Agent } from "../contract/agents";
import type { ChangeBy } from "../shared/domain";
import type { Skill, SkillInput } from "../contract/skills";
import { atomic, ProductDatabase } from "../shared/product-database";
import { required } from "../shared/required";
import { changeByOf } from "../learned-changes/change-source";
import type { ExecutionRepository } from "../bot-store/execution-repository";
import { DefaultSkills } from "./default-skills";
import { SkillToolError } from "./skill-library";
import type { AvailableSkill, SkillToolContext } from "./skill-library";
import { SkillRepository } from "./skill-repository";

export class BotSkills extends Context.Service<
  BotSkills,
  {
    readonly available: (agent: Agent) => Effect.Effect<Array<AvailableSkill>>;
    readonly used: (skill: AvailableSkill) => Effect.Effect<void>;
    readonly own: (agentId: string) => Effect.Effect<Array<Skill>>;
    readonly create: (
      agentId: string,
      input: SkillInput,
      context: SkillToolContext,
    ) => Effect.Effect<Skill>;
    readonly update: (
      skillId: string,
      patch: Partial<SkillInput>,
      context: SkillToolContext,
    ) => Effect.Effect<Skill, SkillToolError>;
    readonly remove: (
      skillId: string,
      context: SkillToolContext,
    ) => Effect.Effect<void, SkillToolError>;
    readonly transaction: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E>;
  }
>()("crumble/skills/BotSkills") {
  static readonly layer = Layer.effect(
    BotSkills,
    Effect.gen(function* () {
      const skills = yield* SkillRepository;
      const db = yield* ProductDatabase;
      const defaultSkills = yield* DefaultSkills;
      const sources = yield* Effect.context<ExecutionRepository>();

      const by = (
        agentId: string,
        context: SkillToolContext,
      ): Effect.Effect<ChangeBy> =>
        changeByOf(agentId, context).pipe(Effect.provideContext(sources));

      const own = (agentId: string) =>
        skills
          .list(agentId)
          .pipe(
            Effect.map((list) =>
              list.filter((skill) => skill.state !== "archived"),
            ),
          );

      const ownedBy = Effect.fnUntraced(function* (skillId: string) {
        const skill = yield* skills.get(skillId);

        if (!skill?.agentId) {
          return yield* Effect.fail(
            new SkillToolError({ message: "Skill not found" }),
          );
        }

        return { ...skill, agentId: skill.agentId };
      });

      const writableBy = Effect.fnUntraced(function* (skillId: string) {
        const skill = yield* ownedBy(skillId);

        if (skill.pinned) {
          return yield* new SkillToolError({
            message: `${skill.name} is pinned by the owner, so bots can't change it`,
          });
        }

        return skill;
      });

      return BotSkills.of({
        available: Effect.fn("BotSkills.available")(function* (agent: Agent) {
          const shared = yield* Effect.forEach(agent.sharedSkills ?? [], (id) =>
            skills.get(id),
          );

          return [
            ...defaultSkills.map((skill) => ({
              ...skill,
              description: skill.description ?? "",
              scope: "default" as const,
            })),
            ...shared.flatMap((skill) =>
              skill && skill.agentId === null && skill.state !== "archived"
                ? [{ ...skill, scope: "shared" as const }]
                : [],
            ),
            ...(yield* own(agent.id)).map((skill) => ({
              ...skill,
              scope: "own" as const,
            })),
          ];
        }),
        used: (skill) =>
          skill.scope === "default" ? Effect.void : skills.recordUse(skill.id),
        own,
        create: Effect.fn("BotSkills.create")(function* (
          agentId: string,
          input: SkillInput,
          context: SkillToolContext,
        ) {
          const change = yield* by(agentId, context);

          return yield* skills.create(
            {
              ...input,
              agentId,
              createdBy: "bot",
              sourceExecutionId: change.source?.executionId ?? null,
            },
            undefined,
            change,
          );
        }),
        update: Effect.fn("BotSkills.update")(function* (
          skillId: string,
          patch: Partial<SkillInput>,
          context: SkillToolContext,
        ) {
          const skill = yield* writableBy(skillId);

          return required(
            yield* skills.update(
              skill.id,
              patch,
              yield* by(skill.agentId, context),
            ),
            "The skill was not stored",
          );
        }),
        remove: Effect.fn("BotSkills.remove")(function* (
          skillId: string,
          context: SkillToolContext,
        ) {
          const skill = yield* writableBy(skillId);
          yield* skills.delete(skill.id, yield* by(skill.agentId, context));
        }),
        transaction: atomic(db),
      });
    }),
  );
}
