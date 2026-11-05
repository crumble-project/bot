import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { ProductDatabase } from "../shared/product-database";
import {
  botMessageRequests,
  delegationReceipts,
  relayedJobQuestions,
} from "./schema";

/** What bot messaging remembers between tool calls. Rows go with the bots and executions they name. */
export const delegationStore = Effect.gen(function* () {
  const db = yield* ProductDatabase;

  return {
    request: Effect.fnUntraced(function* (requestId: string) {
      const [row] = yield* db
        .select()
        .from(botMessageRequests)
        .where(eq(botMessageRequests.requestId, requestId));

      return row;
    }, Effect.orDie),
    reserve: (row: typeof botMessageRequests.$inferInsert) =>
      db.insert(botMessageRequests).values(row).pipe(Effect.orDie),
    receipt: Effect.fnUntraced(function* (executionId: string) {
      const [row] = yield* db
        .select()
        .from(delegationReceipts)
        .where(eq(delegationReceipts.executionId, executionId));

      return row;
    }, Effect.orDie),
    saveReceipt: (row: typeof delegationReceipts.$inferInsert) =>
      db
        .insert(delegationReceipts)
        .values(row)
        .onConflictDoNothing()
        .pipe(Effect.orDie),
    question: Effect.fnUntraced(function* (questionId: string) {
      const [row] = yield* db
        .select()
        .from(relayedJobQuestions)
        .where(eq(relayedJobQuestions.questionId, questionId));

      return row;
    }, Effect.orDie),
    saveQuestion: (row: typeof relayedJobQuestions.$inferInsert) =>
      db
        .insert(relayedJobQuestions)
        .values(row)
        .onConflictDoUpdate({
          target: relayedJobQuestions.questionId,
          set: row,
        })
        .pipe(Effect.orDie),
  };
});
