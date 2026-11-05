import { Context, Effect, Layer } from "effect";
import type { z } from "zod";
import { AgentRepository } from "../bots/agent-repository";
import type { Agent } from "../contract/agents";
import type { listedSkillResponse } from "../contract/api-responses";
import type {
  Skill,
  SkillInput,
  skillLifecycleInput,
} from "../contract/skills";
import {
  InvalidInput,
  NotFound,
  ReadOnly,
  type AppError,
} from "../shared/errors";
import { MAX_BOT_SKILLS } from "../shared/limits";
import { atomic, ProductDatabase } from "../shared/product-database";
import { DefaultSkills } from "./default-skills";
import { SkillInstaller } from "./skill-installer";
import { SkillRepository } from "./skill-repository";

const tooManySkills = () =>
  new InvalidInput({
    message: `A bot can use at most ${MAX_BOT_SKILLS} shared skills`,
  });

/** What the owner may do with skills. `BotSkills` keeps the same for what bots may do. */
export class OwnerSkills extends Context.Service<
  OwnerSkills,
  {
    /** Every skill a bot may use: the default ones the server ships and the shared ones the owner added. */
    readonly catalog: Effect.Effect<z.infer<typeof listedSkillResponse>[]>;
    /** A shared skill; a bot's own skill is not one. */
    readonly shared: (skillId: string) => Effect.Effect<Skill, NotFound>;
    /** A bot's own skill, which must belong to that bot. */
    readonly own: (
      agentId: string,
      skillId: string,
    ) => Effect.Effect<Skill, NotFound>;
    /** A shared skill the owner may edit: a default one can't be, and an installed one follows its upstream. */
    readonly editable: (skillId: string) => Effect.Effect<Skill, AppError>;
    /** Replaces a bot's own skill; the lifecycle fields change only when sent. */
    readonly updateOwn: (
      skillId: string,
      input: SkillInput,
      lifecycle: z.output<typeof skillLifecycleInput>,
    ) => Effect.Effect<Skill | null>;
    /** Deletes a shared skill and drops it from the bots that had it shared. */
    readonly removeShared: (skillId: string) => Effect.Effect<void, AppError>;
    /** Gives `target` the skill: a shared one is linked, a bot's own is copied. Returns true when it already had it. */
    readonly assign: (
      skillId: string,
      target: Agent,
      assigned: boolean,
    ) => Effect.Effect<boolean, AppError>;
    /** Adds `skillIds` to each bot's shared skills: all of them, or none when one bot would go over the limit. */
    readonly shareWith: (
      botIds: string[],
      skillIds: string[],
    ) => Effect.Effect<void, InvalidInput>;
  }
>()("crumble/skills/OwnerSkills") {
  static readonly layer = Layer.effect(
    OwnerSkills,
    Effect.gen(function* () {
      const skills = yield* SkillRepository;
      const agents = yield* AgentRepository;
      const installer = yield* SkillInstaller;
      const defaults = yield* DefaultSkills;
      const transaction = atomic(yield* ProductDatabase);

      const isDefault = (skillId: string) =>
        defaults.some((skill) => skill.id === skillId);

      const readOnly = () =>
        new ReadOnly({ message: "Bundled skills are read-only" });

      const catalog = Effect.gen(function* () {
        const updates = yield* installer.updates;

        return [
          ...defaults.map(
            ({ id, name, description, instructions, documents, path }) => ({
              id,
              name,
              description,
              instructions,
              documents,
              path,
              source: "bundled" as const,
            }),
          ),
          ...(yield* skills.list(null)).map((skill) => ({
            ...skill,
            update: updates.get(skill.id) ?? null,
            source: "shared" as const,
          })),
        ];
      });

      const shared = Effect.fn("OwnerSkills.shared")(function* (
        skillId: string,
      ) {
        const skill = yield* skills.get(skillId);

        if (!skill || skill.agentId)
          return yield* new NotFound({ message: "Skill not found" });

        return skill;
      });

      const own = Effect.fn("OwnerSkills.own")(function* (
        agentId: string,
        skillId: string,
      ) {
        const skill = yield* skills.get(skillId);

        if (!skill || skill.agentId !== agentId)
          return yield* new NotFound({ message: "Skill not found" });

        return skill;
      });

      const editable = Effect.fn("OwnerSkills.editable")(function* (
        skillId: string,
      ) {
        if (isDefault(skillId)) return yield* readOnly();

        const skill = yield* shared(skillId);

        if (skill.origin)
          return yield* new ReadOnly({
            message:
              "Installed skills are read-only. Make a copy to change one.",
          });

        return skill;
      });

      const updateOwn = (
        skillId: string,
        input: SkillInput,
        lifecycle: z.output<typeof skillLifecycleInput>,
      ) =>
        skills.update(skillId, {
          ...input,
          ...(lifecycle.state && { state: lifecycle.state }),
          ...(lifecycle.pinned !== undefined && { pinned: lifecycle.pinned }),
        });

      const removeShared = Effect.fn("OwnerSkills.removeShared")(function* (
        skillId: string,
      ) {
        if (isDefault(skillId)) return yield* readOnly();

        yield* transaction(
          Effect.gen(function* () {
            const skill = yield* skills.get(skillId);

            if (skill?.agentId || !(yield* skills.delete(skillId)))
              return yield* new NotFound({ message: "Skill not found" });

            for (const agent of yield* agents.list) {
              const sharedSkills = agent.sharedSkills ?? [];

              if (sharedSkills.includes(skillId))
                yield* agents.update(agent.id, {
                  sharedSkills: sharedSkills.filter((id) => id !== skillId),
                });
            }
          }),
        );
      });

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
          yield* agents.update(target.id, {
            sharedSkills: (assigned
              ? [...current, source.id]
              : current.filter((id) => id !== source.id)
            ).toSorted(),
          });

        return assigned === already;
      });

      /** Only direct linked copies are matched. The source and same-name skills are never removal targets. */
      const assignOwn = Effect.fnUntraced(function* (
        source: Skill,
        target: Agent,
        assigned: boolean,
      ) {
        if (source.agentId === target.id) return true;

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

      const assign = Effect.fn("OwnerSkills.assign")(function* (
        skillId: string,
        target: Agent,
        assigned: boolean,
      ) {
        if (isDefault(skillId))
          return yield* new ReadOnly({
            message: "Default skills cannot be assigned",
          });

        const source = yield* skills.get(skillId);

        if (!source) return yield* new NotFound({ message: "Skill not found" });

        return yield* source.agentId
          ? assignOwn(source, target, assigned)
          : assignShared(source, target, assigned);
      });

      const shareWith = (botIds: string[], skillIds: string[]) =>
        transaction(
          Effect.gen(function* () {
            for (const botId of botIds) {
              const agent = yield* agents.get(botId);

              if (!agent) continue;

              const sharedSkills = [
                ...new Set([...(agent.sharedSkills ?? []), ...skillIds]),
              ].toSorted();

              if (sharedSkills.length > MAX_BOT_SKILLS)
                return yield* tooManySkills();

              yield* agents.update(agent.id, { sharedSkills });
            }
          }),
        );

      return OwnerSkills.of({
        catalog,
        shared,
        own,
        editable,
        updateOwn,
        removeShared,
        assign,
        shareWith,
      });
    }),
  );
}
