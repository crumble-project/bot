import { Clock, Effect, Semaphore, type Scope } from "effect";
import type { VoiceCallReport } from "../contract/voice-gateway";
import { Conflict, NotFound } from "../shared/errors";
import type { SettingsRepository } from "../shared/settings-repository";
import { loadCalls, saveCalls } from "./call-storage";
import type {
  CallBoundary,
  OutsideCall,
  VoiceCall,
  VoiceCallChange,
  VoiceCallEnd,
  VoiceCallHandler,
  VoiceLine,
} from "./call-types";
import { createPendingCalls } from "./pending-calls";

const KEPT_ENDED = 200;
const RECONNECT_WITHIN_MS = 60_000;
const RECONFIRM_WITHIN_MS = 15_000;

// The voice gateway ends a call after 4 hours.
const CALL_LASTS_MS = (4 * 60 + 5) * 60_000;

type Keyed<K> = {
  readonly size: number;
  keys(): Iterable<K>;
  delete(key: K): boolean;
};

/** Forgets the oldest keys beyond `limit`, skipping those still `inUse`. */
const forgetOldest = <K>(
  keyed: Keyed<K>,
  limit: number,
  inUse: (key: K) => boolean = () => false,
) => {
  for (const key of keyed.keys()) {
    if (keyed.size <= limit) return;

    if (!inUse(key)) keyed.delete(key);
  }
};

export const createCallState = Effect.fnUntraced(function* (
  settings: SettingsRepository["Service"],
  scope: Scope.Scope,
  boundary: CallBoundary,
) {
  // Token changes, config changes, stream registration, and call state take one lock, so nothing lands mid-sweep.
  const changes = yield* Semaphore.make(1);

  let goneAt: number | null = null;

  const stored = yield* loadCalls(settings);
  const active = new Map(stored.active.map((call) => [call.username, call]));
  const ended = new Set(stored.ended);
  const outside = new Map(stored.outside.map((call) => [call.callId, call]));

  // A reloaded call waits for the voice gateway from the first tick on.
  let reloaded = active.size > 0;
  let unsaved = false;
  const calls: VoiceCallChange[] = [];
  let handler: VoiceCallHandler | undefined;
  let announcing = false;

  // A handler that reaches this service again finds the loop running, so it never waits on itself.
  const announce = Effect.gen(function* () {
    if (announcing) return;
    announcing = true;

    yield* Effect.gen(function* () {
      for (let next = calls.shift(); next; next = calls.shift())
        if (handler) yield* handler(next);
    }).pipe(Effect.ensuring(Effect.sync(() => (announcing = false))));
  });

  const save = Effect.suspend(() => {
    if (!unsaved) return Effect.void;
    unsaved = false;

    return saveCalls(settings, active.values(), ended, outside.values());
  });

  // Call changes are saved under the lock, then announced after it, so a marker never holds the lock.
  const locked = <A, E>(effect: Effect.Effect<A, E>) =>
    Semaphore.withPermit(changes, Effect.ensuring(effect, save)).pipe(
      Effect.ensuring(announce),
    );

  const activeCall = (callId: string) =>
    [...active.values()].find((call) => call.callId === callId);

  // A ringing or active outside call keeps its ID, so a report for it is never taken for a call with the owner.
  const rememberOutside = (call: OutsideCall) => {
    outside.set(call.callId, call);
    unsaved = true;
    forgetOldest(
      outside,
      KEPT_ENDED,
      (id) => pending.has(id) || activeCall(id) !== undefined,
    );
  };

  const tombstone = (callId: string) => {
    ended.add(callId);
    unsaved = true;
    forgetOldest(ended, KEPT_ENDED);
  };

  const end = (call: VoiceCall, reason: VoiceCallEnd, now: number) => {
    if (active.get(call.username) !== call) return;
    active.delete(call.username);
    tombstone(call.callId);
    calls.push({
      phase: "ended",
      call,
      reason,
      endedAt: now,
      wakes:
        reason !== "revoked" && (call.direction === "outbound" || call.spoken),
    });
  };

  const pending = createPendingCalls(scope, {
    ...boundary,
    locked,
    hasActive: (username) => active.has(username),
    rememberOutside,
    tombstone,
    save,
    missed: (call, miss) => calls.push({ phase: "missed", call, miss }),
  });

  const callOf = (botId: string) =>
    [...active.values()].find((call) => call.botId === botId);

  const currentCall = (botId: string) =>
    Effect.sync(() => {
      const call = callOf(botId);
      const callee = call && outside.get(call.callId)?.callee;

      return call
        ? { party: call.party, ...(callee !== undefined && { callee }) }
        : null;
    });

  const isActive = (callId: string) =>
    Effect.sync(() => activeCall(callId) !== undefined);

  const hangUp = (botId: string) =>
    locked(
      Effect.sync(() => {
        const call = callOf(botId);

        if (!call) return false;
        call.hangUp = true;
        unsaved = true;

        return true;
      }),
    );

  const hangingUp = (username: string) =>
    Effect.sync(() => active.get(username)?.hangUp === true);

  // Null when the token changed; Conflict once the call ended.
  const onCallLine = <A, E>(
    username: string,
    callId: string,
    hash: string,
    use: (
      found: VoiceLine,
      current: VoiceCall | undefined,
    ) => Effect.Effect<A, E>,
  ) =>
    locked(
      Effect.gen(function* () {
        const found = yield* boundary.line(
          yield* boundary.reconcile(),
          username,
          hash,
        );

        if (!found) return null;

        if (ended.has(callId))
          return yield* new Conflict({ message: "The call ended" });

        return yield* use(found, active.get(username));
      }),
    );

  const busy = (
    username: string,
    callId: string,
    placed: { username: string } | undefined,
  ) =>
    active.has(username) ||
    activeCall(callId) !== undefined ||
    (placed !== undefined && placed.username !== username);

  const begin = (
    username: string,
    callId: string,
    found: VoiceLine,
    now: number,
  ) => {
    const placed = pending.event(callId);

    // Only its start report while it rings makes an outside call active; it never becomes a call with the owner.
    if (outside.has(callId) && !placed)
      return Effect.fail(
        new Conflict({ message: "The outside call is not ringing" }),
      );

    if (busy(username, callId, placed))
      return Effect.fail(
        new Conflict({ message: "Another call is active on the line" }),
      );

    pending.started(callId);

    const call: VoiceCall = {
      callId,
      username,
      botId: found.botId,
      direction: placed ? "outbound" : "inbound",
      party: placed?.party ?? "owner",
      greeting: placed?.greeting,
      startedAt: now,
      confirmedAt: now,
      spoken: false,
    };

    active.set(username, call);
    unsaved = true;
    calls.push({ phase: "started", call });

    return Effect.succeed(true as const);
  };

  const startCall = (username: string, callId: string, hash: string) =>
    onCallLine(username, callId, hash, (found, current) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        if (current?.callId !== callId)
          return begin(username, callId, found, now);
        current.confirmedAt = now;
        unsaved = true;

        return Effect.succeed(true as const);
      }),
    );

  const notActive = () =>
    Effect.fail(
      new Conflict({
        message: "The outside call is not active on the line",
      }),
    );

  const speak = (username: string, callId: string, hash: string) =>
    onCallLine(username, callId, hash, (found, current) => {
      const ongoing = outside.get(callId) ?? null;

      if (ongoing && current?.callId !== callId) return notActive();

      if (current?.callId === callId && !current.spoken) {
        current.spoken = true;
        unsaved = true;
      }

      return Effect.succeed({ ...found, outside: ongoing });
    });

  const outsideOn = (username: string) => {
    const current = active.get(username);

    return current?.party === "outside"
      ? (outside.get(current.callId) ?? null)
      : null;
  };

  const route = (username: string, hash: string, callId: string | undefined) =>
    locked(
      Effect.gen(function* () {
        const found = yield* boundary.line(
          yield* boundary.reconcile(),
          username,
          hash,
        );

        if (!found) return null;
        const ongoing = outsideOn(username);

        if (callId === undefined) return { ...found, outside: ongoing };

        if (outside.has(callId) && ongoing?.callId !== callId)
          return yield* notActive();

        return {
          ...found,
          outside: ongoing?.callId === callId ? ongoing : null,
        };
      }),
    );

  const reportEnded = (
    callId: string,
    report: Extract<VoiceCallReport, { outcome: "ended" }>,
    now: number,
  ) => {
    const started = activeCall(callId);

    if (started)
      end(
        started,
        started.hangUp && report.reason === "hungUp"
          ? "botHungUp"
          : report.reason,
        now,
      );
    else tombstone(callId);

    pending.report(callId, report);
  };

  const reportCall = (callId: string, report: VoiceCallReport, hash: string) =>
    locked(
      Effect.gen(function* () {
        if (!boundary.acceptsToken(hash)) return null;

        if (report.outcome === "ended") {
          reportEnded(callId, report, yield* Clock.currentTimeMillis);

          return true as const;
        }

        if (!pending.report(callId, report) && !activeCall(callId))
          return yield* new NotFound({ message: "Unknown call" });

        return true as const;
      }),
    );

  // A call the voice gateway can no longer report ends here: its stream is gone, or a new one never confirmed it.
  const expire = (now: number) => {
    const live = boundary.connection();

    if (reloaded) {
      reloaded = false;

      if (!live) goneAt = now;
    }

    for (const call of active.values()) {
      const unconfirmed = live
        ? call.confirmedAt < live.openedAt &&
          now - live.openedAt >= RECONFIRM_WITHIN_MS
        : now - Math.max(goneAt ?? 0, call.confirmedAt) >= RECONNECT_WITHIN_MS;

      if (unconfirmed || now - call.startedAt >= CALL_LASTS_MS)
        end(call, "lost", now);
    }
  };

  const handleCalls = (next: VoiceCallHandler) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        handler = next;
      }),
      () =>
        Effect.sync(() => {
          handler = undefined;
        }),
    );

  const reassign = (
    username: string,
    botId: string | undefined,
    now: number,
  ) => {
    const call = active.get(username);

    // The first sweep after a restart sees every line as new; a reloaded call stays with its bot.
    if (call && call.botId !== botId) end(call, "lineChanged", now);

    pending.reassign(username);
  };

  return {
    locked,
    reassign,
    endAll: (now: number) => {
      for (const call of active.values()) end(call, "revoked", now);
    },
    revokePending: pending.revoke,
    connected: () => {
      goneAt = null;
    },
    disconnected: (now: number) => {
      goneAt = now;
    },
    replay: pending.replay,
    hasActive: () => active.size > 0,
    expire,
    api: {
      ...pending.api,
      currentCall,
      isActive,
      hangUp,
      hangingUp,
      startCall,
      speak,
      route,
      reportCall,
      handleCalls,
    },
  };
});
