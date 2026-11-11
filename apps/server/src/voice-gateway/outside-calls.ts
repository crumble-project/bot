import { Effect, Layer } from "effect";
import { CallNotes, type CallLine } from "../bot-ports/call-notes";
import { Bots } from "../bots/bots";
import { BotRuntime } from "../bots/runtime";
import type { CallRequest } from "../contract/voice-gateway";
import { AgentRepository } from "../bot-store/agent-repository";
import { logged } from "../shared/app-errors";
import { callRequestRequest, voiceCallRequest } from "../shared/request-ids";
import type { TranscriptMessage } from "../transcript/transcript";
import { endNotice } from "./call-notices";
import { CallRequests } from "./call-requests";
import { outsideEndedText, outsideMissedText } from "./call-text";
import {
  VoiceGateway,
  type OutsideCallMiss,
  type VoiceCallChange,
} from "./voice-gateway";

const RESTARTED: OutsideCallMiss = {
  outcome: "failed",
  error: "the server restarted",
};

// The transcript a note reads: enough for the 12,000 characters it keeps.
const NOTE_MESSAGES = 200;

const lineOf = (message: TranscriptMessage): CallLine[] => {
  const text = message.content.trim();

  if (!text) return [];

  if (message.role === "user") return [{ speaker: "callee", text }];

  return message.role === "assistant" ? [{ speaker: "bot", text }] : [];
};

type OutsideDeps = {
  bots: Bots["Service"];
  requests: CallRequests["Service"];
};

/** Tells the bot how its outside call came out, or, while it is disabled, writes the line as a marker only. */
const report = (
  { bots }: OutsideDeps,
  request: CallRequest,
  text: string,
  wakes: boolean,
) =>
  endNotice(
    bots,
    request.agentId,
    {
      callId: request.callId ?? request.id,
      phase: "ended",
      direction: "outbound",
      callee: request.callee,
      text,
    },
    request.callId
      ? voiceCallRequest(request.callId, "ended")
      : callRequestRequest(request.id),
    wakes,
  );

const missed = Effect.fnUntraced(function* (
  deps: OutsideDeps,
  request: CallRequest,
  miss: OutsideCallMiss,
) {
  if (
    !(yield* deps.requests.finish(request.id, {
      outcome: miss.outcome,
      error: miss.error ?? null,
    }))
  )
    return;

  yield* report(deps, request, outsideMissedText(request.callee, miss), true);
});

const ended = Effect.fnUntraced(function* (
  deps: OutsideDeps,
  request: CallRequest,
  change: Extract<VoiceCallChange, { phase: "ended" }>,
) {
  if (request.conversationId)
    yield* deps.bots
      .abort(request.conversationId)
      .pipe(Effect.catchTag("NotFound", () => Effect.void));

  const objected = yield* deps.requests.objected(request);

  if (
    !(yield* deps.requests.finish(request.id, {
      outcome: "answered",
      error: null,
    }))
  )
    return;

  const text = outsideEndedText(
    request.callee,
    change.reason,
    change.endedAt - change.call.startedAt,
    objected,
  );

  yield* report(deps, request, text, change.wakes);
});

/** Writes an outside call's markers, ends its call request, and wakes its bot once; false for a call with the owner. */
export const markOutsideCall = Effect.fnUntraced(function* (
  deps: OutsideDeps,
  change: VoiceCallChange,
) {
  if (change.phase !== "missed" && change.call.party !== "outside")
    return false;
  const request = yield* deps.requests.byCall(change.call.callId);

  if (!request) return true;

  switch (change.phase) {
    case "started":
      yield* deps.bots.recordCallEvent(
        request.agentId,
        {
          callId: change.call.callId,
          phase: "started",
          direction: "outbound",
          callee: request.callee,
          greeting: request.opening,
        },
        voiceCallRequest(change.call.callId, "started"),
      );
      break;
    case "ended":
      yield* ended(deps, request, change);
      break;
    case "missed":
      yield* missed(deps, request, change.miss);
  }

  return true;
});

/**
 * Gives the turn an outside call's end starts the goal and the transcript, for the model only, and ends call requests
 * a restart left calling: their call rang in memory, so the voice gateway's start report for it now answers 409.
 */
export const outsideCalls = Layer.effectDiscard(
  Effect.gen(function* () {
    const requests = yield* CallRequests;
    const runtime = yield* BotRuntime;
    const agents = yield* AgentRepository;

    const transcript = Effect.fnUntraced(function* (request: CallRequest) {
      const { conversationId } = request;
      const agent = yield* agents.get(request.agentId);

      if (!conversationId || !agent) return [];

      const page = yield* Effect.promise(() =>
        runtime.conversationHistory(agent, conversationId, {
          limit: NOTE_MESSAGES,
        }),
      );

      return [
        { speaker: "bot" as const, text: request.opening },
        ...page.messages.flatMap(lineOf),
      ];
    });

    yield* (yield* CallNotes).provide((agentId, callId) =>
      Effect.gen(function* () {
        const request = yield* requests.byCall(callId);

        if (request?.agentId !== agentId) return;
        const about = { callee: request.callee, goal: request.goal };

        if (request.outcome !== "answered")
          return { ...about, kind: "missed" as const };

        if (yield* requests.objected(request))
          return { ...about, kind: "objected" as const };

        return {
          ...about,
          kind: "ended" as const,
          transcript: yield* transcript(request),
        };
      }),
    );
  }),
);

export const recoverOutsideCalls = Effect.gen(function* () {
  const deps = { bots: yield* Bots, requests: yield* CallRequests };
  const gateway = yield* VoiceGateway;

  for (const request of yield* deps.requests.calling)
    if (!request.callId || !(yield* gateway.isActive(request.callId)))
      yield* missed(deps, request, RESTARTED).pipe(
        logged("Ending an outside call left calling failed", request.id),
      );
});
