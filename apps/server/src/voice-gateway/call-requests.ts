import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { and, desc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { AgentRepository } from "../bot-store/agent-repository";
import { ConversationRepository } from "../bot-store/conversation-repository";
import { BotNotices, loggedNotices } from "../bot-ports/bot-notices";
import { BotRuntime } from "../bots/runtime";
import type { CallRequest } from "../contract/voice-gateway";
import { pi } from "../shared/app-errors";
import { localConversationId } from "../shared/entry-ids";
import {
  Conflict,
  InvalidInput,
  NotFound,
  type AppError,
} from "../shared/errors";
import { ProductDatabase } from "../shared/product-database";
import { callRequestRequest } from "../shared/request-ids";
import { nowIso } from "../shared/time";
import type { PageOptions } from "../transcript/transcript";
import { openCallConversation, outsideCallOf } from "./call-conversation";
import { outsideNumber } from "./outside-numbers";
import { callRequests } from "./schema";
import { VoiceGateway } from "./voice-gateway";

export type CallRequestInput = Pick<
  CallRequest,
  "number" | "callee" | "goal" | "opening"
>;

type CallRequestEnd = Pick<CallRequest, "outcome" | "error"> & {
  outcome: NonNullable<CallRequest["outcome"]>;
};

const requestOf = (row: typeof callRequests.$inferSelect): CallRequest => ({
  ...row,
});

const NO_TRANSCRIPT = { messages: [], hasMore: false, oldestEntryId: null };

export class CallRequests extends Context.Service<
  CallRequests,
  {
    /** Stores a pending call request after the number rules; Conflict while another one is pending. */
    readonly request: (
      agentId: string,
      input: CallRequestInput,
    ) => Effect.Effect<CallRequest, AppError>;
    readonly list: (agentId: string) => Effect.Effect<CallRequest[]>;
    /**
     * Opens the call conversation and dials at once, so no bot turn runs between approval and dialing. Conflict, with
     * the request pending again, when the number or the line refuses the call.
     */
    readonly approve: (
      agentId: string,
      requestId: string,
    ) => Effect.Effect<CallRequest, AppError>;
    readonly decline: (
      agentId: string,
      requestId: string,
    ) => Effect.Effect<CallRequest, AppError>;
    /** The call conversation's messages; none before the call, or once the callee objected. */
    readonly transcript: (
      agentId: string,
      requestId: string,
      options: PageOptions,
    ) => Effect.Effect<
      Awaited<ReturnType<BotRuntime["Service"]["conversationHistory"]>>,
      AppError
    >;
    readonly byCall: (callId: string) => Effect.Effect<CallRequest | null>;
    /** Ends a calling request with its outcome; false when it no longer calls. */
    readonly finish: (
      requestId: string,
      end: CallRequestEnd,
    ) => Effect.Effect<boolean>;
    readonly calling: Effect.Effect<CallRequest[]>;
    /** Whether the callee objected, so the call's transcript is withheld. */
    readonly objected: (request: CallRequest) => Effect.Effect<boolean>;
  }
>()("crumble/voice-gateway/CallRequests") {
  static readonly layer = Layer.effect(
    CallRequests,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const agents = yield* AgentRepository;
      const conversations = yield* ConversationRepository;
      const runtime = yield* BotRuntime;
      const gateway = yield* VoiceGateway;

      const notify = loggedNotices(
        yield* BotNotices,
        "Call request notice failed",
      );

      const getRow = Effect.fnUntraced(function* (
        agentId: string,
        requestId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(callRequests)
          .where(
            and(
              eq(callRequests.agentId, agentId),
              eq(callRequests.id, requestId),
            ),
          )
          .pipe(Effect.orDie);

        return row;
      });

      const found = Effect.fnUntraced(function* (
        agentId: string,
        requestId: string,
      ) {
        const row = yield* getRow(agentId, requestId);

        return row
          ? requestOf(row)
          : yield* new NotFound({ message: "Call request not found" });
      });

      const agentOf = Effect.fnUntraced(function* (agentId: string) {
        return (
          (yield* agents.get(agentId)) ??
          (yield* new NotFound({ message: "Agent not found" }))
        );
      });

      // One atomic update moves a pending request on, so a second approval finds none.
      const claim = Effect.fnUntraced(function* (
        agentId: string,
        requestId: string,
        status: "calling" | "declined",
      ) {
        const [row] = yield* db
          .update(callRequests)
          .set({ status, decidedAt: yield* nowIso })
          .where(
            and(
              eq(callRequests.id, requestId),
              eq(callRequests.agentId, agentId),
              eq(callRequests.status, "pending"),
            ),
          )
          .returning()
          .pipe(Effect.orDie);

        if (row) return requestOf(row);
        yield* found(agentId, requestId);

        return yield* new Conflict({
          message: "The call request has already been decided",
        });
      });

      const reopen = (requestId: string) =>
        db
          .update(callRequests)
          .set({
            status: "pending",
            decidedAt: null,
            callId: null,
            conversationId: null,
          })
          .where(
            and(
              eq(callRequests.id, requestId),
              eq(callRequests.status, "calling"),
            ),
          )
          .pipe(Effect.orDie, Effect.asVoid);

      const pendingOf = (agentId: string) =>
        db
          .select({ id: callRequests.id })
          .from(callRequests)
          .where(
            and(
              eq(callRequests.agentId, agentId),
              eq(callRequests.status, "pending"),
            ),
          )
          .limit(1)
          .pipe(Effect.orDie);

      const ownerNumbers = Effect.map(
        gateway.describe,
        (description) => description.config.ownerNumbers,
      );

      const request = Effect.fn("CallRequests.request")(function* (
        agentId: string,
        input: CallRequestInput,
      ) {
        const { number, refusal } = outsideNumber(
          input.number,
          yield* ownerNumbers,
        );

        if (number === null)
          return yield* new InvalidInput({ message: refusal });
        const id = crypto.randomUUID();
        const requestedAt = yield* nowIso;

        // One transaction checks and inserts, so two requests at once leave one pending.
        const stored = yield* db
          .transaction(() =>
            Effect.gen(function* () {
              if ((yield* pendingOf(agentId)).length) return false;

              yield* db.insert(callRequests).values({
                id,
                agentId,
                ...input,
                number,
                status: "pending",
                requestedAt,
              });

              return true;
            }),
          )
          .pipe(Effect.orDie);

        if (!stored)
          return yield* new Conflict({
            message:
              "A call request is already pending; wait for the owner's answer.",
          });

        return yield* found(agentId, id);
      });

      const list = Effect.fn("CallRequests.list")(function* (agentId: string) {
        const rows = yield* db
          .select()
          .from(callRequests)
          .where(eq(callRequests.agentId, agentId))
          .orderBy(desc(callRequests.requestedAt))
          .pipe(Effect.orDie);

        return rows.map(requestOf);
      });

      // The refusal, or null once the call event is sent.
      const dial = Effect.fnUntraced(function* (claimed: CallRequest) {
        const { number, refusal } = outsideNumber(
          claimed.number,
          yield* ownerNumbers,
        );

        if (number === null) return refusal;
        const lineRefusal = yield* gateway.othersRefusal(claimed.agentId);

        if (lineRefusal) return lineRefusal;
        const agent = yield* agentOf(claimed.agentId);

        const conversationId = yield* pi(() =>
          openCallConversation(runtime, agent, claimed),
        );

        yield* conversations.create(
          { agentId: agent.id, title: claimed.callee },
          conversationId,
        );
        const callId = crypto.randomUUID();

        yield* db
          .update(callRequests)
          .set({ callId, conversationId })
          .where(eq(callRequests.id, claimed.id))
          .pipe(Effect.orDie);

        return yield* gateway.callOutside({
          botId: agent.id,
          requestId: claimed.id,
          callId,
          conversationId,
          callee: claimed.callee,
          number,
          opening: claimed.opening,
        });
      });

      const approve = Effect.fn("CallRequests.approve")(function* (
        agentId: string,
        requestId: string,
      ) {
        const claimed = yield* claim(agentId, requestId, "calling");

        const refusal = yield* dial(claimed).pipe(
          Effect.onError(() => reopen(requestId)),
        );

        if (refusal) {
          yield* reopen(requestId);

          return yield* new Conflict({ message: refusal });
        }

        return yield* found(agentId, requestId);
      });

      const decline = Effect.fn("CallRequests.decline")(function* (
        agentId: string,
        requestId: string,
      ) {
        const declined = yield* claim(agentId, requestId, "declined");

        yield* notify(
          agentId,
          `The owner declined your call request to ${declined.callee}.`,
          callRequestRequest(requestId),
        );

        return declined;
      });

      const objected = Effect.fnUntraced(function* (request: CallRequest) {
        const { conversationId } = request;
        const agent = yield* agents.get(request.agentId);

        if (!conversationId || !agent) return false;

        const call = yield* Effect.promise(async () =>
          outsideCallOf(
            await runtime.documents(agent),
            localConversationId(agent.id, conversationId),
            BACKGROUND_CONTEXT,
          ),
        );

        return call?.objected === true;
      });

      const transcript = Effect.fn("CallRequests.transcript")(function* (
        agentId: string,
        requestId: string,
        options: PageOptions,
      ) {
        const call = yield* found(agentId, requestId);
        const { conversationId } = call;

        if (!conversationId || (yield* objected(call))) return NO_TRANSCRIPT;
        const agent = yield* agentOf(agentId);

        return yield* pi(() =>
          runtime.conversationHistory(agent, conversationId, options),
        );
      });

      const byCall = Effect.fn("CallRequests.byCall")(function* (
        callId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(callRequests)
          .where(eq(callRequests.callId, callId))
          .pipe(Effect.orDie);

        return row ? requestOf(row) : null;
      });

      const finish = Effect.fn("CallRequests.finish")(function* (
        requestId: string,
        end: CallRequestEnd,
      ) {
        const changed = yield* db
          .update(callRequests)
          .set({
            status: "ended",
            outcome: end.outcome,
            error: end.error,
            endedAt: yield* nowIso,
          })
          .where(
            and(
              eq(callRequests.id, requestId),
              eq(callRequests.status, "calling"),
            ),
          )
          .returning({ id: callRequests.id })
          .pipe(Effect.orDie);

        return changed.length > 0;
      });

      const calling = db
        .select()
        .from(callRequests)
        .where(eq(callRequests.status, "calling"))
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map(requestOf)),
        );

      return CallRequests.of({
        request,
        list,
        approve,
        decline,
        transcript,
        byCall,
        finish,
        calling,
        objected,
      });
    }),
  );
}
