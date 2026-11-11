import { Deferred, Effect, Option, type Scope } from "effect";
import type {
  VoiceCallEvent,
  VoiceCallReport,
  VoiceGatewayServedConfig,
} from "../contract/voice-gateway";
import { callLine, callTarget } from "./call-policy";
import type {
  CallBoundary,
  CallRequest,
  OutsideCall,
  OutsideCallMiss,
  OutsideCallRequest,
  SettledCall,
} from "./call-types";

const LINE_CHANGED = "The line was given to another bot or turned off.";
const ACKNOWLEDGE_WITHIN = "15 seconds";
const KEPT_PLACED = 200;

// The voice gateway rings for at most 3 minutes.
const SETTLE_WITHIN = "210 seconds";

type PendingEnd = Exclude<
  SettledCall,
  { outcome: "unacknowledged" | "timedOut" }
>;

// Lowercase without a period, like the voice gateway's own errors, as each ends a sentence the owner reads.
const UNREPORTED = {
  unacknowledged: "the voice gateway did not take the call",
  timedOut: "the voice gateway did not report how the call ended",
  revoked: "the voice gateway token was revoked or replaced",
};

function missOf(result: SettledCall): OutsideCallMiss {
  if (result.outcome === "unanswered" || result.outcome === "busy")
    return { outcome: result.outcome };

  if (result.outcome === "failed")
    return { outcome: "failed", error: result.error };

  if (result.outcome === "answered")
    return {
      outcome: "failed",
      error: "the call was answered but did not start",
    };

  return { outcome: "failed", error: UNREPORTED[result.outcome] };
}

/** `started`: its start report made it the line's active call. */
type PendingCall = {
  key: string;
  botId: string;
  started?: boolean;
  event: VoiceCallEvent;
  acknowledged: Deferred.Deferred<void>;
  settled: Deferred.Deferred<PendingEnd>;
};

type PendingBoundary = Pick<
  CallBoundary,
  "reconcile" | "connection" | "allowsOthers"
> & {
  locked: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  hasActive: (username: string) => boolean;
  rememberOutside: (call: OutsideCall) => void;
  tombstone: (callId: string) => void;
  save: Effect.Effect<void>;
  missed: (
    call: { callId: string; botId: string },
    miss: OutsideCallMiss,
  ) => void;
};

export const createPendingCalls = (
  scope: Scope.Scope,
  boundary: PendingBoundary,
) => {
  const { locked, rememberOutside, tombstone, save } = boundary;
  const pending = new Map<string, PendingCall>();
  const placed = new Set<string>();

  const settlePending = (call: PendingCall, settled: PendingEnd) => {
    pending.delete(call.event.callId);
    Deferred.doneUnsafe(call.acknowledged, Effect.void);
    Deferred.doneUnsafe(call.settled, Effect.succeed(settled));
  };

  // The ID is tombstoned, so a start report still on its way cannot begin the call.
  const cancel = (callId: string) => {
    tombstone(callId);

    const live = boundary.connection();

    if (live?.calls) live.send({ event: "cancel", data: { callId } });
  };

  const availability = (current: VoiceGatewayServedConfig) => ({
    connected: boundary.connection()?.calls === true,
    othersAllowed: new Set(
      current.lines
        .filter((line) => boundary.allowsOthers(line.username))
        .map((line) => line.username),
    ),
    active: new Set(
      current.lines
        .filter((line) => boundary.hasActive(line.username))
        .map((line) => line.username),
    ),
    ringing: new Set([...pending.values()].map((call) => call.event.username)),
  });

  const callRefusal = (botId: string) =>
    locked(
      Effect.map(
        boundary.reconcile(),
        (current) => callTarget(current, botId, availability(current)).refusal,
      ),
    );

  const othersRefusal = (botId: string) =>
    locked(
      Effect.map(
        boundary.reconcile(),
        (current) =>
          callLine(current, botId, "outside", availability(current)).refusal,
      ),
    );

  const callsOthers = (botId: string) =>
    locked(
      Effect.map(boundary.reconcile(), (current) =>
        current.lines.some(
          (served) =>
            served.botId === botId && boundary.allowsOthers(served.username),
        ),
      ),
    );

  // The key names the tool call or the call request, so neither dials twice; a pending call's key stays.
  const ring = Effect.fnUntraced(function* (
    key: string,
    botId: string,
    event: VoiceCallEvent,
  ) {
    const ringing = new Set([...pending.values()].map((call) => call.key));

    placed.add(key);

    for (const kept of placed) {
      if (placed.size <= KEPT_PLACED) break;

      if (!ringing.has(kept)) placed.delete(kept);
    }

    const call: PendingCall = {
      key,
      botId,
      event,
      acknowledged: yield* Deferred.make<void>(),
      settled: yield* Deferred.make<PendingEnd>(),
    };

    pending.set(event.callId, call);

    return call;
  });

  const place = (request: CallRequest) =>
    locked(
      Effect.gen(function* () {
        if (placed.has(request.key))
          return { refusal: "This call was already placed.", call: null };

        const current = yield* boundary.reconcile();

        const { refusal, target } = callTarget(
          current,
          request.botId,
          availability(current),
        );

        if (!target) return { refusal, call: null };

        const call = yield* ring(request.key, request.botId, {
          callId: crypto.randomUUID(),
          ...target,
          greeting: request.greeting,
        });

        boundary.connection()?.send({ event: "call", data: call.event });

        return { refusal: null, call };
      }),
    );

  const placeOutside = (request: OutsideCallRequest) =>
    locked(
      Effect.gen(function* () {
        if (placed.has(request.requestId))
          return {
            refusal: "This call request was already placed.",
            call: null,
          };

        const current = yield* boundary.reconcile();

        const { refusal, line } = callLine(
          current,
          request.botId,
          "outside",
          availability(current),
        );

        if (!line) return { refusal, call: null };

        const call = yield* ring(request.requestId, request.botId, {
          callId: request.callId,
          username: line.username,
          to: request.number,
          greeting: request.opening,
          party: "outside",
        });

        rememberOutside({
          callId: request.callId,
          requestId: request.requestId,
          conversationId: request.conversationId,
          botId: request.botId,
          callee: request.callee,
        });
        // Stored before the event is sent, so no start report for it can ever begin a call with the owner.
        yield* save;
        boundary.connection()?.send({ event: "call", data: call.event });

        return { refusal: null, call };
      }),
    );

  // Still pending: nobody settled the call, so the voice gateway must hang up.
  const drop = (call: PendingCall) =>
    locked(
      Effect.sync(() => {
        const { callId } = call.event;

        if (pending.get(callId) !== call) return;
        pending.delete(callId);
        cancel(callId);
      }),
    );

  const settle = (call: PendingCall) =>
    Effect.gen(function* () {
      const acknowledged = yield* Effect.timeoutOption(
        Deferred.await(call.acknowledged),
        ACKNOWLEDGE_WITHIN,
      );

      return Option.isSome(acknowledged)
        ? yield* Deferred.await(call.settled)
        : { outcome: "unacknowledged" as const };
    }).pipe(
      Effect.timeoutOption(SETTLE_WITHIN),
      Effect.map(Option.getOrElse(() => ({ outcome: "timedOut" as const }))),
    );

  const callOwner = Effect.fn("VoiceGateway.callOwner")(function* (
    request: CallRequest,
  ) {
    const { refusal, call } = yield* place(request);

    if (!call) return { outcome: "refused" as const, reason: refusal };

    return yield* settle(call).pipe(Effect.ensuring(drop(call)));
  });

  // An answered call that started ends through its end report instead.
  const missed = (call: PendingCall, result: SettledCall) =>
    locked(
      Effect.sync(() => {
        if (call.started) return;
        const { callId } = call.event;

        tombstone(callId);
        boundary.missed({ callId, botId: call.botId }, missOf(result));
      }),
    );

  const callOutside = Effect.fn("VoiceGateway.callOutside")(function* (
    request: OutsideCallRequest,
  ) {
    const { refusal, call } = yield* placeOutside(request);

    if (!call) return refusal;

    yield* settle(call).pipe(
      Effect.ensuring(drop(call)),
      Effect.flatMap((result) => missed(call, result)),
      Effect.forkIn(scope),
    );

    return null;
  });

  return {
    has: (callId: string) => pending.has(callId),
    event: (callId: string) => pending.get(callId)?.event,
    started: (callId: string) => {
      const call = pending.get(callId);

      if (!call) return;
      call.started = true;
      settlePending(call, { outcome: "answered" });
    },
    report: (callId: string, report: VoiceCallReport) => {
      const call = pending.get(callId);

      if (!call) return false;
      Deferred.doneUnsafe(call.acknowledged, Effect.void);

      if (report.outcome === "ended")
        settlePending(call, { outcome: "failed", error: report.error });
      else if (report.outcome !== "ringing")
        settlePending(call, { outcome: report.outcome, error: report.error });

      return true;
    },
    reassign: (username: string) => {
      // A ringing call belongs to the bot that placed it, not to the line's next bot.
      for (const call of pending.values())
        if (call.event.username === username) {
          cancel(call.event.callId);
          settlePending(call, { outcome: "failed", error: LINE_CHANGED });
        }
    },
    revoke: () => {
      for (const call of pending.values())
        settlePending(call, { outcome: "revoked" });
    },
    replay: () => {
      for (const call of pending.values())
        if (!Deferred.isDoneUnsafe(call.acknowledged))
          boundary.connection()?.send({ event: "call", data: call.event });
    },
    api: { callRefusal, othersRefusal, callsOthers, callOwner, callOutside },
  };
};
