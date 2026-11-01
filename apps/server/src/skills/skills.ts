import { Context, Effect, Layer } from "effect";
import { isSqlError } from "effect/sql/SqlError";
import type { Agent, ChangeBy, Skill, SkillInput } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { changeSourceOf } from "../memory/memory-sources";
import { ExecutionRepository } from "../bots/execution-repository";
import { CommonSkills, type CommonSkill } from "./common-skills";
import type { Runner } from "../shared/runner";
import {
  SkillToolError,
  type AvailableSkill,
  type SkillToolContext,
} from "./skill-library";
import { SkillRepository } from "./skill-repository";

/** The skills a bot can read and the ones it may write: the server's defaults, shared skills it uses, and its own. */
export class BotSkills extends Context.Service<
  BotSkills,
  {
    /** Defaults, shared skills the bot uses, and its own, archived ones excluded. */
    readonly available: (agent: Agent) => Effect.Effect<AvailableSkill[]>;
    readonly used: (agent: Agent, skill: AvailableSkill) => Effect.Effect<void>;
    /** The bot's own skills, archived ones excluded. */
    readonly own: (agentId: string) => Effect.Effect<Skill[]>;
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
    /** Runs `effect` atomically: the writes inside join one transaction, and a failure undoes them all. */
    readonly transaction: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E>;
  }
>()("crumble/skills/BotSkills") {
  static readonly make = Effect.gen(function* () {
    const skills = yield* SkillRepository;
    const db = yield* ProductDatabase;
    const commonSkills = yield* CommonSkills;
    const sources = yield* Effect.context<ExecutionRepository>();

    const source = (agentId: string, context: SkillToolContext) =>
      changeSourceOf(agentId, context).pipe(Effect.provideContext(sources));

    const by = (
      agentId: string,
      context: SkillToolContext,
    ): Effect.Effect<ChangeBy> =>
      context.reviewOf
        ? Effect.succeed({
            actor: "review",
            source: { executionId: context.reviewOf },
          })
        : source(agentId, context).pipe(
            Effect.map((change): ChangeBy => ({
              actor: "bot",
              source: change,
            })),
          );

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

      if (!skill?.agentId)
        return yield* Effect.fail(
          new SkillToolError({ message: "Skill not found" }),
        );

      return { ...skill, agentId: skill.agentId };
    });

    /** The bot's own skill, which it may change unless the owner pinned it. */
    const writableBy = Effect.fnUntraced(function* (skillId: string) {
      const skill = yield* ownedBy(skillId);

      if (skill.pinned)
        return yield* new SkillToolError({
          message: `${skill.name} is pinned by the owner, so bots can't change it`,
        });

      return skill;
    });

    return BotSkills.of({
      available: Effect.fn("BotSkills.available")(function* (agent: Agent) {
        const shared = yield* Effect.forEach(agent.sharedSkills ?? [], (id) =>
          skills.get(id),
        );

        return [
          ...commonSkills.map((skill) => ({
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
      used: (_agent, skill) =>
        skill.scope === "default" ? Effect.void : skills.recordUse(skill.id),
      own,
      create: Effect.fn("BotSkills.create")(function* (
        agentId: string,
        input: SkillInput,
        context: SkillToolContext,
      ) {
        return yield* skills.create(
          {
            ...input,
            agentId,
            createdBy: "bot",
            sourceExecutionId:
              context.reviewOf ??
              (yield* source(agentId, context)).executionId ??
              null,
          },
          undefined,
          yield* by(agentId, context),
        );
      }),
      update: Effect.fn("BotSkills.update")(function* (
        skillId: string,
        patch: Partial<SkillInput>,
        context: SkillToolContext,
      ) {
        const skill = yield* writableBy(skillId);

        return (yield* skills.update(
          skill.id,
          patch,
          yield* by(skill.agentId, context),
        ))!;
      }),
      remove: Effect.fn("BotSkills.remove")(function* (
        skillId: string,
        context: SkillToolContext,
      ) {
        const skill = yield* writableBy(skillId);
        yield* skills.delete(skill.id, yield* by(skill.agentId, context));
      }),
      transaction: (effect) =>
        db
          .transaction(() => effect)
          .pipe(Effect.catchIf(isSqlError, Effect.die)),
    });
  });

  static readonly layer = Layer.effect(BotSkills, BotSkills.make);
}

/** The skills of `store`'s account with `commonSkills` as defaults, for a test without an account. */
export const standaloneSkills = (
  store: {
    runtime: Runner<SkillRepository | ProductDatabase | ExecutionRepository>;
  },
  commonSkills: CommonSkill[] = [],
) =>
  store.runtime.runSync(
    BotSkills.make.pipe(Effect.provideService(CommonSkills, commonSkills)),
  );
