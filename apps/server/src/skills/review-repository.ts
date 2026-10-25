import { asc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { pendingReviews, reviewCounters } from "./schema";

export type PendingReview = {
  executionId: string;
  agentId: string;
  conversationId: string;
  createdAt: string;
};

/** When each bot reviews its work next, and the reviews in flight. */
export class ReviewRepository extends Context.Service<
  ReviewRepository,
  {
    /** Adds a turn's tool-activity rounds to the bot's review counters and returns the totals. */
    readonly addRounds: (
      agentId: string,
      skillRounds: number,
      memoryRounds: number,
    ) => Effect.Effect<{ skill: number; memory: number }>;
    readonly counters: (
      agentId: string,
    ) => Effect.Effect<{ skill: number; memory: number }>;
    /** Sets one counter: zero after a review fired, or the rounds after a turn's last write to that store. */
    readonly setCounter: (
      agentId: string,
      counter: "skill" | "memory",
      rounds: number,
    ) => Effect.Effect<void>;
    /** Reviews in flight; a server restart drops them instead of resuming. */
    readonly listPending: Effect.Effect<PendingReview[]>;
    readonly addPending: (
      executionId: string,
      agentId: string,
      conversationId: string,
    ) => Effect.Effect<void>;
    readonly removePending: (executionId: string) => Effect.Effect<void>;
  }
>()("crumble/skills/ReviewRepository") {
  static readonly layer = Layer.effect(
    ReviewRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const counters = Effect.fn("ReviewRepository.counters")(function* (
        agentId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(reviewCounters)
          .where(eq(reviewCounters.agentId, agentId));

        return { skill: row?.skillRounds ?? 0, memory: row?.memoryRounds ?? 0 };
      }, Effect.orDie);

      const addRounds = Effect.fn("ReviewRepository.addRounds")(function* (
        agentId: string,
        skillRounds: number,
        memoryRounds: number,
      ) {
        yield* db
          .insert(reviewCounters)
          .values({ agentId, skillRounds, memoryRounds })
          .onConflictDoUpdate({
            target: reviewCounters.agentId,
            set: {
              skillRounds: sql`${reviewCounters.skillRounds} + excluded.skill_rounds`,
              memoryRounds: sql`${reviewCounters.memoryRounds} + excluded.memory_rounds`,
            },
          });

        return yield* counters(agentId);
      }, Effect.orDie);

      const setCounter = Effect.fn("ReviewRepository.setCounter")(function* (
        agentId: string,
        counter: "skill" | "memory",
        rounds: number,
      ) {
        const set =
          counter === "skill"
            ? { skillRounds: rounds }
            : { memoryRounds: rounds };

        yield* db
          .insert(reviewCounters)
          .values({ agentId, ...set })
          .onConflictDoUpdate({ target: reviewCounters.agentId, set });
      }, Effect.orDie);

      const listPending = db
        .select()
        .from(pendingReviews)
        .orderBy(asc(pendingReviews.createdAt))
        .pipe(Effect.orDie, Effect.withSpan("ReviewRepository.listPending"));

      const addPending = Effect.fn("ReviewRepository.addPending")(function* (
        executionId: string,
        agentId: string,
        conversationId: string,
      ) {
        const row = { agentId, conversationId, createdAt: yield* nowIso };

        yield* db
          .insert(pendingReviews)
          .values({ executionId, ...row })
          .onConflictDoUpdate({ target: pendingReviews.executionId, set: row });
      }, Effect.orDie);

      const removePending = Effect.fn("ReviewRepository.removePending")(
        function* (executionId: string) {
          yield* db
            .delete(pendingReviews)
            .where(eq(pendingReviews.executionId, executionId));
        },
        Effect.orDie,
      );

      return ReviewRepository.of({
        addRounds,
        counters,
        setCounter,
        listPending,
        addPending,
        removePending,
      });
    }),
  );
}
