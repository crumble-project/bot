import { asc, eq, isNull, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { OWNER } from "../shared/change-by";
import {
  skillStates,
  type ChangeBy,
  type Skill,
  type SkillDocument,
  type SkillInput,
} from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { LearnedChangeRepository } from "./learned-change-repository";
import { skillDocuments, skills } from "./schema";

export type NewSkill = SkillInput & {
  agentId?: string | null;
  createdBy?: Skill["createdBy"];
  sourceExecutionId?: string | null;
  state?: Skill["state"];
  pinned?: boolean;
};

export type SkillPatch = Partial<
  Omit<Skill, "id" | "agentId" | "createdAt" | "updatedAt">
>;

const isSkillState = (state: string): state is Skill["state"] =>
  skillStates.some((known) => known === state);

/** The skill library: shared skills, each bot's own, and their reference documents. */
export class SkillRepository extends Context.Service<
  SkillRepository,
  {
    /** One bot's skills, or the shared ones for `null`, oldest first. */
    readonly list: (agentId?: string | null) => Effect.Effect<Skill[]>;
    readonly get: (skillId: string) => Effect.Effect<Skill | null>;
    readonly create: (
      input: NewSkill,
      skillId?: string,
      by?: ChangeBy | null,
    ) => Effect.Effect<Skill>;
    readonly update: (
      skillId: string,
      patch: SkillPatch,
      by?: ChangeBy | null,
    ) => Effect.Effect<Skill | null>;
    readonly delete: (
      skillId: string,
      by?: ChangeBy | null,
    ) => Effect.Effect<boolean>;
    /** Puts a skill back as it was, keeping its ID, timestamps, and usage; records nothing. */
    readonly restore: (skill: Skill) => Effect.Effect<void>;
    /** Deletes a skill without recording a change, for reverts that record their own. */
    readonly discard: (skillId: string) => Effect.Effect<void>;
    /** Loading a skill counts as using it, and brings a stale skill back to active. */
    readonly recordUse: (skillId: string) => Effect.Effect<void>;
    /** Bot-created skills across every bot, for the curator. */
    readonly listBotCreated: Effect.Effect<Skill[]>;
    /** A bot's inline `skills` write: matched by name, so a kept skill keeps its documents, provenance, and usage. */
    readonly replaceAgentSkills: (
      agentId: string,
      inline: ReadonlyArray<{ name: string; instructions: string }>,
    ) => Effect.Effect<void>;
  }
>()("crumble/skills/SkillRepository") {
  static readonly layer = Layer.effect(
    SkillRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const changes = yield* LearnedChangeRepository;

      const skillOf = Effect.fnUntraced(function* (
        row: typeof skills.$inferSelect,
      ) {
        const documents = yield* db
          .select({
            path: skillDocuments.path,
            content: skillDocuments.content,
          })
          .from(skillDocuments)
          .where(eq(skillDocuments.skillId, row.id))
          .orderBy(asc(skillDocuments.path));

        const skill: Skill = {
          id: row.id,
          agentId: row.agentId ?? null,
          name: row.name,
          description: row.description,
          instructions: row.instructions,
          documents,
          createdBy: row.createdBy === "bot" ? "bot" : "owner",
          sourceExecutionId: row.sourceExecutionId ?? null,
          useCount: row.useCount,
          lastUsedAt: row.lastUsedAt ?? null,
          state: isSkillState(row.state) ? row.state : "active",
          pinned: row.pinned,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };

        return skill;
      });

      const list = Effect.fn("SkillRepository.list")(function* (
        agentId: string | null,
      ) {
        const rows = yield* db
          .select()
          .from(skills)
          .where(agentId ? eq(skills.agentId, agentId) : isNull(skills.agentId))
          .orderBy(asc(skills.createdAt), sql`rowid`);

        return yield* Effect.forEach(rows, skillOf);
      }, Effect.orDie);

      const get = Effect.fn("SkillRepository.get")(function* (skillId: string) {
        const [row] = yield* db
          .select()
          .from(skills)
          .where(eq(skills.id, skillId));

        return row ? yield* skillOf(row) : null;
      }, Effect.orDie);

      const writeDocuments = Effect.fnUntraced(function* (
        skillId: string,
        documents: ReadonlyArray<SkillDocument>,
      ) {
        yield* db
          .delete(skillDocuments)
          .where(eq(skillDocuments.skillId, skillId));

        if (documents.length)
          yield* db.insert(skillDocuments).values(
            documents.map((document) => ({
              skillId,
              path: document.path,
              content: document.content,
            })),
          );
      });

      const create = Effect.fn("SkillRepository.create")(function* (
        input: NewSkill,
        skillId: string = crypto.randomUUID(),
        by: ChangeBy | null = OWNER,
      ) {
        const at = yield* nowIso;

        yield* db.transaction(() =>
          Effect.gen(function* () {
            yield* db.insert(skills).values({
              id: skillId,
              agentId: input.agentId ?? null,
              name: input.name,
              description: input.description,
              instructions: input.instructions,
              createdBy: input.createdBy ?? "owner",
              sourceExecutionId: input.sourceExecutionId ?? null,
              state: input.state ?? "active",
              pinned: input.pinned ?? false,
              createdAt: at,
              updatedAt: at,
            });
            yield* writeDocuments(skillId, input.documents);
          }),
        );

        const skill = (yield* get(skillId))!;
        yield* changes.record(
          by,
          "skill",
          skill.agentId,
          skill.id,
          null,
          skill,
        );

        return skill;
      }, Effect.orDie);

      const update = Effect.fn("SkillRepository.update")(function* (
        skillId: string,
        patch: SkillPatch,
        by: ChangeBy | null = OWNER,
      ) {
        const old = yield* get(skillId);

        if (!old) return null;
        const next = { ...old, ...patch };
        const at = yield* nowIso;

        yield* db.transaction(() =>
          Effect.gen(function* () {
            yield* db
              .update(skills)
              .set({
                name: next.name,
                description: next.description,
                instructions: next.instructions,
                createdBy: next.createdBy,
                sourceExecutionId: next.sourceExecutionId,
                useCount: next.useCount,
                lastUsedAt: next.lastUsedAt,
                state: next.state,
                pinned: next.pinned,
                updatedAt: at,
              })
              .where(eq(skills.id, skillId));

            if (patch.documents)
              yield* writeDocuments(skillId, patch.documents);
          }),
        );

        const skill = (yield* get(skillId))!;
        yield* changes.record(by, "skill", old.agentId, old.id, old, skill);

        return skill;
      }, Effect.orDie);

      const discard = Effect.fn("SkillRepository.discard")(function* (
        skillId: string,
      ) {
        yield* db.delete(skills).where(eq(skills.id, skillId));
      }, Effect.orDie);

      const remove = Effect.fn("SkillRepository.delete")(function* (
        skillId: string,
        by: ChangeBy | null = OWNER,
      ) {
        const old = yield* get(skillId);

        if (!old) return false;
        yield* discard(skillId);
        yield* changes.record(by, "skill", old.agentId, old.id, old, null);

        return true;
      });

      const restore = Effect.fn("SkillRepository.restore")(function* (
        skill: Skill,
      ) {
        yield* db.transaction(() =>
          Effect.gen(function* () {
            yield* db.insert(skills).values({
              id: skill.id,
              agentId: skill.agentId,
              name: skill.name,
              description: skill.description,
              instructions: skill.instructions,
              createdBy: skill.createdBy,
              sourceExecutionId: skill.sourceExecutionId,
              useCount: skill.useCount,
              lastUsedAt: skill.lastUsedAt,
              state: skill.state,
              pinned: skill.pinned,
              createdAt: skill.createdAt,
              updatedAt: skill.updatedAt,
            });
            yield* writeDocuments(skill.id, skill.documents);
          }),
        );
      }, Effect.orDie);

      const recordUse = Effect.fn("SkillRepository.recordUse")(function* (
        skillId: string,
      ) {
        yield* db
          .update(skills)
          .set({
            useCount: sql`${skills.useCount} + 1`,
            lastUsedAt: yield* nowIso,
            state: sql`CASE WHEN ${skills.state} = 'stale' THEN 'active' ELSE ${skills.state} END`,
          })
          .where(eq(skills.id, skillId));
      }, Effect.orDie);

      const listBotCreated = Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(skills)
          .where(eq(skills.createdBy, "bot"))
          .orderBy(asc(skills.createdAt));

        return yield* Effect.forEach(rows, skillOf);
      }).pipe(Effect.orDie, Effect.withSpan("SkillRepository.listBotCreated"));

      const replaceAgentSkills = Effect.fn(
        "SkillRepository.replaceAgentSkills",
      )(function* (
        agentId: string,
        inline: ReadonlyArray<{ name: string; instructions: string }>,
      ) {
        yield* db.transaction(() =>
          Effect.gen(function* () {
            const existing = yield* list(agentId);
            const kept = new Set<string>();

            for (const skill of inline) {
              const match = existing.find(
                (candidate) =>
                  candidate.name === skill.name && !kept.has(candidate.id),
              );

              if (match) {
                kept.add(match.id);

                if (match.instructions !== skill.instructions)
                  yield* update(match.id, { instructions: skill.instructions });
              } else
                kept.add(
                  (yield* create({
                    agentId,
                    name: skill.name,
                    description: "",
                    instructions: skill.instructions,
                    documents: [],
                  })).id,
                );
            }

            for (const skill of existing)
              if (!kept.has(skill.id)) yield* remove(skill.id);
          }),
        );
      }, Effect.orDie);

      return SkillRepository.of({
        list: (agentId = null) => list(agentId),
        get,
        create,
        update,
        delete: remove,
        restore,
        discard,
        recordUse,
        listBotCreated,
        replaceAgentSkills,
      });
    }),
  );
}
