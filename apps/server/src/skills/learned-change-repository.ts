import { and, asc, desc, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { ChangeBy, LearnedChange, Memory, Skill } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { learnedChanges, reviewResults } from "./schema";

const changeOf = (row: typeof learnedChanges.$inferSelect): LearnedChange => ({
  id: row.id,
  agentId: row.agentId ?? null,
  actor: row.actor,
  target: row.target,
  targetId: row.targetId,
  action: row.action,
  before: row.beforeState ? JSON.parse(row.beforeState) : null,
  after: row.afterState ? JSON.parse(row.afterState) : null,
  source: row.source ? JSON.parse(row.source) : null,
  revertsId: row.revertsId ?? null,
  createdAt: row.createdAt,
});

export type ReviewResult = {
  executionId: string;
  agentId: string;
  createdAt: string;
  changes: LearnedChange[];
};

/** The record of skill and memory changes, kept so the owner can review and undo them. */
export class LearnedChangeRepository extends Context.Service<
  LearnedChangeRepository,
  {
    /**
     * Records a change by `by`, or nothing when `by` is null. Recording is telemetry: a failure is logged and returns
     * null, so it can neither fail nor undo the change itself.
     */
    readonly record: (
      by: ChangeBy | null,
      target: LearnedChange["target"],
      agentId: string | null,
      targetId: string,
      before: Skill | Memory | null,
      after: Skill | Memory | null,
      revertsId?: string | null,
    ) => Effect.Effect<string | null>;
    /** Newest first: one bot's, the shared ones for `null`, or every change when `agentId` is undefined. */
    readonly list: (
      agentId: string | null | undefined,
      options?: { limit?: number | undefined; before?: string | undefined },
    ) => Effect.Effect<LearnedChange[]>;
    readonly get: (changeId: string) => Effect.Effect<LearnedChange | null>;
    /** The changes one execution's review made, oldest first. */
    readonly listOfExecution: (
      executionId: string,
      actor: LearnedChange["actor"],
    ) => Effect.Effect<LearnedChange[]>;
    /** What a review of one execution changed, kept so clients can show it after the fact. */
    readonly addReviewResult: (
      executionId: string,
      agentId: string,
      changeIds: string[],
    ) => Effect.Effect<void>;
    readonly listReviewResults: (
      agentId: string,
      limit?: number,
    ) => Effect.Effect<ReviewResult[]>;
  }
>()("crumble/skills/LearnedChangeRepository") {
  static readonly layer = Layer.effect(
    LearnedChangeRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const get = Effect.fn("LearnedChangeRepository.get")(function* (
        changeId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(learnedChanges)
          .where(eq(learnedChanges.id, changeId));

        return row ? changeOf(row) : null;
      }, Effect.orDie);

      const record = Effect.fn("LearnedChangeRepository.record")(function* (
        by: ChangeBy | null,
        target: LearnedChange["target"],
        agentId: string | null,
        targetId: string,
        before: Skill | Memory | null,
        after: Skill | Memory | null,
        revertsId: string | null = null,
      ) {
        if (!by) return null;
        const changeId = crypto.randomUUID();

        const action: LearnedChange["action"] = revertsId
          ? "revert"
          : before === null
            ? "create"
            : after === null
              ? "delete"
              : "update";

        return yield* db
          .insert(learnedChanges)
          .values({
            id: changeId,
            agentId,
            actor: by.actor,
            target,
            targetId,
            action,
            beforeState: before ? JSON.stringify(before) : null,
            afterState: after ? JSON.stringify(after) : null,
            source: by.source ? JSON.stringify(by.source) : null,
            revertsId,
            createdAt: yield* nowIso,
          })
          .pipe(
            Effect.as<string | null>(changeId),
            Effect.catchCause((cause) =>
              Effect.logError(
                "Recording a learned change failed",
                target,
                targetId,
                cause,
              ).pipe(Effect.as(null)),
            ),
          );
      });

      const list = Effect.fn("LearnedChangeRepository.list")(function* (
        agentId: string | null | undefined,
        options: {
          limit?: number | undefined;
          before?: string | undefined;
        } = {},
      ) {
        const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
        const cursor = options.before ? yield* get(options.before) : null;
        const clauses: SQL[] = [];

        if (agentId === null) clauses.push(isNull(learnedChanges.agentId));
        else if (agentId !== undefined)
          clauses.push(eq(learnedChanges.agentId, agentId));

        if (cursor)
          clauses.push(
            or(
              lt(learnedChanges.createdAt, cursor.createdAt),
              and(
                eq(learnedChanges.createdAt, cursor.createdAt),
                sql`rowid < (SELECT rowid FROM learned_changes WHERE id = ${cursor.id})`,
              ),
            )!,
          );

        const rows = yield* db
          .select()
          .from(learnedChanges)
          .where(and(...clauses))
          .orderBy(desc(learnedChanges.createdAt), sql`rowid DESC`)
          .limit(limit);

        return rows.map(changeOf);
      }, Effect.orDie);

      const listOfExecution = Effect.fn(
        "LearnedChangeRepository.listOfExecution",
      )(function* (executionId: string, actor: LearnedChange["actor"]) {
        const rows = yield* db
          .select()
          .from(learnedChanges)
          .where(
            and(
              eq(learnedChanges.actor, actor),
              sql`json_extract(${learnedChanges.source}, '$.executionId') = ${executionId}`,
            ),
          )
          .orderBy(asc(learnedChanges.createdAt), sql`rowid`);

        return rows.map(changeOf);
      }, Effect.orDie);

      const addReviewResult = Effect.fn(
        "LearnedChangeRepository.addReviewResult",
      )(function* (executionId: string, agentId: string, changeIds: string[]) {
        const row = {
          agentId,
          changeIds: JSON.stringify(changeIds),
          createdAt: yield* nowIso,
        };

        yield* db
          .insert(reviewResults)
          .values({ executionId, ...row })
          .onConflictDoUpdate({ target: reviewResults.executionId, set: row });
      }, Effect.orDie);

      const listReviewResults = Effect.fn(
        "LearnedChangeRepository.listReviewResults",
      )(function* (agentId: string, limit: number = 50) {
        const rows = yield* db
          .select({
            executionId: reviewResults.executionId,
            changeIds: reviewResults.changeIds,
            createdAt: reviewResults.createdAt,
          })
          .from(reviewResults)
          .where(eq(reviewResults.agentId, agentId))
          .orderBy(desc(reviewResults.createdAt), sql`rowid DESC`)
          .limit(Math.min(Math.max(limit, 1), 200));

        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            // SAFETY: change_ids holds the JSON array `addReviewResult` wrote.
            const changeIds = JSON.parse(row.changeIds) as string[];

            const changes = yield* Effect.forEach(changeIds, get);

            return {
              executionId: row.executionId,
              agentId,
              createdAt: row.createdAt,
              changes: changes.filter((change) => change !== null),
            };
          }),
        );
      }, Effect.orDie);

      return LearnedChangeRepository.of({
        record,
        list,
        get,
        listOfExecution,
        addReviewResult,
        listReviewResults,
      });
    }),
  );
}
