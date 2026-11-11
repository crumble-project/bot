import { and, desc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import {
  attachmentInput,
  type AttachmentInput,
} from "../shared/attachment-rules";
import { ACTIVE_EXECUTION_STATUSES, type Execution } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { executions } from "./schema.executions";

export type NewExecution = Omit<Execution, "id" | "createdAt" | "updatedAt"> & {
  prompt?: string;
  replyTo?: string | null;
  attachments?: string[];
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

export class ExecutionRepository extends Context.Service<
  ExecutionRepository,
  {
    /** Newest first. */
    readonly list: (agentId?: string) => Effect.Effect<Execution[]>;
    /** The pending and running ones, of one bot or of every bot; newest first. */
    readonly active: (agentId?: string) => Effect.Effect<Execution[]>;
    readonly latestIn: (
      conversationId: string,
    ) => Effect.Effect<Execution | null>;
    readonly get: (executionId: string) => Effect.Effect<Execution | null>;
    readonly getByRequest: (
      conversationId: string,
      requestId: string,
    ) => Effect.Effect<Execution | null>;
    /** The bot's newest execution under `requestId`, whichever conversation holds it. */
    readonly findByRequest: (
      agentId: string,
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
    /** Uploads waiting for admission; cleared once Pi holds them, so they are not stored twice. */
    readonly attachments: (
      executionId: string,
    ) => Effect.Effect<
      | { kind: "files"; ids: string[] }
      | { kind: "legacy"; attachments: AttachmentInput[] }
    >;
    readonly clearAttachments: (executionId: string) => Effect.Effect<void>;
  }
>()("crumble/bot-store/ExecutionRepository") {
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

      const active = Effect.fn("ExecutionRepository.active")(function* (
        agentId: string | undefined,
      ) {
        const rows = yield* db
          .select()
          .from(executions)
          .where(
            and(
              inArray(executions.status, ACTIVE_EXECUTION_STATUSES),
              agentId ? eq(executions.agentId, agentId) : undefined,
            ),
          )
          .orderBy(desc(executions.createdAt));

        return rows.map(executionOf);
      }, Effect.orDie);

      const latestIn = Effect.fn("ExecutionRepository.latestIn")(function* (
        conversationId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(executions)
          .where(eq(executions.conversationId, conversationId))
          .orderBy(desc(executions.createdAt))
          .limit(1);

        return row ? executionOf(row) : null;
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

      const findByRequest = Effect.fn("ExecutionRepository.findByRequest")(
        function* (agentId: string, requestId: string) {
          const [row] = yield* db
            .select()
            .from(executions)
            .where(
              and(
                eq(executions.agentId, agentId),
                eq(executions.requestId, requestId),
              ),
            )
            .orderBy(desc(executions.createdAt))
            .limit(1);

          return row ? executionOf(row) : null;
        },
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

      const attachments = Effect.fn("ExecutionRepository.attachments")(
        function* (executionId: string) {
          const [row] = yield* db
            .select({ attachments: executions.attachments })
            .from(executions)
            .where(eq(executions.id, executionId));

          if (!row?.attachments) return { kind: "files" as const, ids: [] };

          const value: unknown = JSON.parse(row.attachments);
          const parsed = z.array(z.uuid()).safeParse(value);
          const legacy = z.array(attachmentInput).safeParse(value);

          return parsed.success
            ? { kind: "files" as const, ids: parsed.data }
            : {
                kind: "legacy" as const,
                attachments: legacy.success ? legacy.data : [],
              };
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
        active: (agentId) => active(agentId),
        latestIn,
        get,
        getByRequest,
        findByRequest,
        findBySubmission,
        create,
        update,
        attachments,
        clearAttachments,
      });
    }),
  );
}
