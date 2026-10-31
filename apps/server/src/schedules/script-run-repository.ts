import { and, desc, eq, lt, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { ScriptRun } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { scriptRuns } from "./schema.script-runs";

type FinishedRun = Pick<
  ScriptRun,
  "exitCode" | "output" | "droppedBytes" | "error"
> & {
  status: Exclude<ScriptRun["status"], "running">;
  finishedAt: string;
};

export class ScriptRunRepository extends Context.Service<
  ScriptRunRepository,
  {
    readonly create: (run: ScriptRun) => Effect.Effect<void>;
    readonly finish: (id: string, result: FinishedRun) => Effect.Effect<void>;
    readonly list: (
      scheduleId: string,
      options: { limit: number; before?: string | undefined },
    ) => Effect.Effect<ScriptRun[]>;
    readonly interruptRunning: (finishedAt: string) => Effect.Effect<void>;
    readonly prune: (beforeIso: string) => Effect.Effect<void>;
  }
>()("crumble/schedules/ScriptRunRepository") {
  static readonly layer = Layer.effect(
    ScriptRunRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const create = Effect.fn("ScriptRunRepository.create")(function* (
        run: ScriptRun,
      ) {
        yield* db.insert(scriptRuns).values(run);
      }, Effect.orDie);

      const finish = Effect.fn("ScriptRunRepository.finish")(function* (
        id: string,
        result: FinishedRun,
      ) {
        yield* db.update(scriptRuns).set(result).where(eq(scriptRuns.id, id));
      }, Effect.orDie);

      const list = Effect.fn("ScriptRunRepository.list")(function* (
        scheduleId: string,
        options: { limit: number; before?: string | undefined },
      ) {
        const [cursor] = options.before
          ? yield* db
              .select()
              .from(scriptRuns)
              .where(
                and(
                  eq(scriptRuns.scheduleId, scheduleId),
                  eq(scriptRuns.id, options.before),
                ),
              )
          : [];

        if (options.before && !cursor) return [];

        return yield* db
          .select()
          .from(scriptRuns)
          .where(
            and(
              eq(scriptRuns.scheduleId, scheduleId),
              cursor
                ? or(
                    lt(scriptRuns.startedAt, cursor.startedAt),
                    and(
                      eq(scriptRuns.startedAt, cursor.startedAt),
                      lt(scriptRuns.id, cursor.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(scriptRuns.startedAt), desc(scriptRuns.id))
          .limit(options.limit);
      }, Effect.orDie);

      const interruptRunning = Effect.fn(
        "ScriptRunRepository.interruptRunning",
      )(function* (finishedAt: string) {
        yield* db
          .update(scriptRuns)
          .set({ status: "interrupted", finishedAt })
          .where(eq(scriptRuns.status, "running"));
      }, Effect.orDie);

      const prune = Effect.fn("ScriptRunRepository.prune")(function* (
        beforeIso: string,
      ) {
        yield* db.delete(scriptRuns).where(lt(scriptRuns.startedAt, beforeIso));
      }, Effect.orDie);

      return ScriptRunRepository.of({
        create,
        finish,
        list,
        interruptRunning,
        prune,
      });
    }),
  );
}
