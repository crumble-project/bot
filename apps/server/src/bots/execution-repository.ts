import { and, desc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { AttachmentInput } from "../shared/attachments";
import type { Execution } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { executions } from "./schema";

export type NewExecution = Omit<Execution, "id" | "createdAt" | "updatedAt"> & {
  prompt?: string;
  replyTo?: string | null;
  attachments?: AttachmentInput[];
};

const executionOf = (row: typeof executions.$inferSelect): Execution => ({
  id: row.id,
  agentId: row.agentId,
  conversationId: row.conversationId,
  scheduleId: row.scheduleId,
  submissionId: row.submissionId,
  requestId: row.requestId,
  status: row.status,
  error: row.error,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  prompt: row.prompt ?? "",
  replyTo: row.replyTo ?? null,
  attachmentsDigest: row.attachmentsDigest ?? null,
});

/** Each input a bot is asked to answer, from admission until it settles. */
export class ExecutionRepository extends Context.Service<
  ExecutionRepository,
  {
    /** Newest first. */
    readonly list: (agentId?: string) => Effect.Effect<Execution[]>;
    readonly get: (executionId: string) => Effect.Effect<Execution | null>;
    readonly getByRequest: (
      conversationId: string,
      requestId: string,
    ) => Effect.Effect<Execution | null>;
    readonly findBySubmission: (
      agentId: string,
      submissionId: string,
    ) => Effect.Effect<Execution | null>;
    readonly create: (
      input: NewExecution,
      executionId?: string,
    ) => Effect.Effect<Execution>;
    readonly update: (
      executionId: string,
      patch: Partial<Execution>,
    ) => Effect.Effect<Execution | null>;
    readonly delete: (executionId: string) => Effect.Effect<boolean>;
    /** Uploads waiting for admission; cleared once Pi holds them, so they are not stored twice. */
    readonly attachments: (
      executionId: string,
    ) => Effect.Effect<AttachmentInput[]>;
    readonly clearAttachments: (executionId: string) => Effect.Effect<void>;
  }
>()("crumble/bots/ExecutionRepository") {
  static readonly layer = Layer.effect(
    ExecutionRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const list = Effect.fn("ExecutionRepository.list")(function* (
        agentId: string | undefined,
      ) {
        const rows = yield* db
          .select()
          .from(executions)
          .where(agentId ? eq(executions.agentId, agentId) : undefined)
          .orderBy(desc(executions.createdAt));

        return rows.map(executionOf);
      }, Effect.orDie);

      const first = Effect.fnUntraced(function* (
        where: ReturnType<typeof eq> | undefined,
      ) {
        const [row] = yield* db.select().from(executions).where(where);

        return row ? executionOf(row) : null;
      });

      const get = Effect.fn("ExecutionRepository.get")(
        (executionId: string) => first(eq(executions.id, executionId)),
        Effect.orDie,
      );

      const getByRequest = Effect.fn("ExecutionRepository.getByRequest")(
        (conversationId: string, requestId: string) =>
          first(
            and(
              eq(executions.conversationId, conversationId),
              eq(executions.requestId, requestId),
            ),
          ),
        Effect.orDie,
      );

      const findBySubmission = Effect.fn(
        "ExecutionRepository.findBySubmission",
      )(
        (agentId: string, submissionId: string) =>
          first(
            and(
              eq(executions.agentId, agentId),
              eq(executions.submissionId, submissionId),
            ),
          ),
        Effect.orDie,
      );

      const create = Effect.fn("ExecutionRepository.create")(function* (
        input: NewExecution,
        executionId: string = crypto.randomUUID(),
      ) {
        const at = yield* nowIso;

        yield* db.insert(executions).values({
          id: executionId,
          agentId: input.agentId,
          conversationId: input.conversationId,
          scheduleId: input.scheduleId,
          submissionId: input.submissionId,
          requestId: input.requestId,
          prompt: input.prompt ?? null,
          replyTo: input.replyTo ?? null,
          attachments: input.attachments?.length
            ? JSON.stringify(input.attachments)
            : null,
          attachmentsDigest: input.attachmentsDigest ?? null,
          status: input.status,
          error: input.error,
          createdAt: at,
          updatedAt: at,
        });

        return (yield* get(executionId))!;
      }, Effect.orDie);

      const update = Effect.fn("ExecutionRepository.update")(function* (
        executionId: string,
        patch: Partial<Execution>,
      ) {
        const execution = yield* get(executionId);

        if (!execution) return null;
        const next = { ...execution, ...patch };

        yield* db
          .update(executions)
          .set({
            status: next.status,
            error: next.error,
            submissionId: next.submissionId,
            requestId: next.requestId,
            replyTo: next.replyTo ?? null,
            updatedAt: yield* nowIso,
          })
          .where(eq(executions.id, executionId));

        return yield* get(executionId);
      }, Effect.orDie);

      const remove = Effect.fn("ExecutionRepository.delete")(function* (
        executionId: string,
      ) {
        const deleted = yield* db
          .delete(executions)
          .where(eq(executions.id, executionId))
          .returning({ id: executions.id });

        return deleted.length > 0;
      }, Effect.orDie);

      const attachments = Effect.fn("ExecutionRepository.attachments")(
        function* (executionId: string) {
          const [row] = yield* db
            .select({ attachments: executions.attachments })
            .from(executions)
            .where(eq(executions.id, executionId));

          // SAFETY: the column holds the AttachmentInput array `create` wrote.
          return row?.attachments
            ? (JSON.parse(row.attachments) as AttachmentInput[])
            : [];
        },
        Effect.orDie,
      );

      const clearAttachments = Effect.fn(
        "ExecutionRepository.clearAttachments",
      )(function* (executionId: string) {
        yield* db
          .update(executions)
          .set({ attachments: null })
          .where(eq(executions.id, executionId));
      }, Effect.orDie);

      return ExecutionRepository.of({
        list: (agentId) => list(agentId),
        get,
        getByRequest,
        findBySubmission,
        create,
        update,
        delete: remove,
        attachments,
        clearAttachments,
      });
    }),
  );
}
