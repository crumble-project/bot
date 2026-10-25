import { Context, Effect, Layer } from "effect";
import type { ChangeBy, LearnedChange, Memory, Skill } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { MemoryRepository } from "../memory/memory-repository";
import { LearnedChangeRepository } from "./learned-change-repository";
import { SkillRepository } from "./skill-repository";

/** Undoes recorded skill and memory changes. */
export class ChangeReverter extends Context.Service<
  ChangeReverter,
  {
    /** Restores the state before `changeId`, recording the revert as a change of its own. */
    readonly revert: (
      changeId: string,
      by: ChangeBy,
    ) => Effect.Effect<LearnedChange | null>;
  }
>()("crumble/skills/ChangeReverter") {
  static readonly layer = Layer.effect(
    ChangeReverter,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const changes = yield* LearnedChangeRepository;
      const skills = yield* SkillRepository;
      const memories = yield* MemoryRepository;

      const revert = Effect.fn("ChangeReverter.revert")(function* (
        changeId: string,
        by: ChangeBy,
      ) {
        const change = yield* changes.get(changeId);

        if (!change) return null;

        return yield* db.transaction(() =>
          Effect.gen(function* () {
            const current =
              change.target === "skill"
                ? yield* skills.get(change.targetId)
                : yield* memories.get(change.targetId);

            if (change.target === "skill") {
              // SAFETY: a change's before state has the shape of its target, written by the same repository.
              const before = change.before as Skill | null;

              if (current) yield* skills.discard(change.targetId);

              if (before) yield* skills.restore(before);
            } else {
              // SAFETY: a change's before state has the shape of its target, written by the same repository.
              const before = change.before as Memory | null;

              if (current) yield* memories.discard(change.targetId);

              if (before) yield* memories.restore(before);
            }

            const revertId = yield* changes.record(
              by,
              change.target,
              change.agentId,
              change.targetId,
              current,
              change.before,
              change.id,
            );

            return revertId ? yield* changes.get(revertId) : null;
          }),
        );
      }, Effect.orDie);

      return ChangeReverter.of({ revert });
    }),
  );
}
