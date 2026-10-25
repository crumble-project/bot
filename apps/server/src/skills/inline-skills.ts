import { eq, ne } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { agents } from "../bots/schema";
import { ProductDatabase } from "../shared/product-database";
import { SkillRepository } from "./skill-repository";

/**
 * Skills became packages in one library: a bot's own skills move out of its agent row into it. Any inline skills
 * left behind are transferred at every startup, in one transaction, so a crash can neither lose them nor leave them
 * in both places.
 */
export const InlineSkillsTransfer = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* ProductDatabase;
    const skills = yield* SkillRepository;

    yield* db.transaction(() =>
      Effect.gen(function* () {
        const rows = yield* db
          .select({ id: agents.id, skills: agents.skills })
          .from(agents)
          .where(ne(agents.skills, "[]"));

        for (const row of rows) {
          // SAFETY: the agents.skills column always held the inline skill array.
          const inline = JSON.parse(row.skills) as Array<{
            name: string;
            instructions: string;
          }>;

          for (const skill of inline)
            yield* skills.create(
              {
                agentId: row.id,
                name: skill.name,
                description: "",
                instructions: skill.instructions,
                documents: [],
              },
              undefined,
              null,
            );

          yield* db
            .update(agents)
            .set({ skills: "[]" })
            .where(eq(agents.id, row.id));
        }
      }),
    );
  }).pipe(Effect.orDie),
);
