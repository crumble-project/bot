import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Semaphore,
  type Scope,
} from "effect";
import { z } from "zod";
import { AgentRepository } from "../bot-store/agent-repository";
import type { Agent } from "../contract/agents";
import {
  defaultVoiceGatewayConfig,
  voiceGatewayConfigInput,
  type VoiceCallEndReason,
  type VoiceCallEvent,
  type VoiceCallReport,
  type VoiceGatewayConfig,
  type VoiceGatewayDescription,
  type VoiceGatewayServedConfig,
  type VoiceLinesReport,
} from "../contract/voice-gateway";
import { Conflict, InvalidInput, NotFound } from "../shared/errors";
import { SettingsRepository } from "../shared/settings-repository";
import { startTicking } from "../shared/ticker";
import { nowIso } from "../shared/time";
import { CALL_DIRECTIONS, type CallEventData } from "../transcript/entries";

const CONFIG_KEY = "voice-gateway";
const TOKEN_KEY = "voice-gateway:token";
const CALLS_KEY = "voice-gateway:calls";
const LINE_CHANGED = "The line was given to another bot or turned off.";

const ACKNOWLEDGE_WITHIN = "15 seconds";
const KEPT_PLACED = 200;

// The voice gateway rings for at most 3 minutes.
const SETTLE_WITHIN = "210 seconds";

const KEPT_ENDED = 200;
const RECONNECT_WITHIN_MS = 60_000;
const RECONFIRM_WITHIN_MS = 15_000;

// The voice gateway ends a call after 4 hours.
const CALL_LASTS_MS = (4 * 60 + 5) * 60_000;

const issuedToken = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/u),
  issuedAt: z.string(),
});

type IssuedToken = z.infer<typeof issuedToken>;

/** The active calls and the IDs of ended ones, kept across a restart. */
const storedCalls = z.object({
  active: z.array(
    z.object({
      callId: z.string(),
      username: z.string(),
      botId: z.string(),
      direction: z.enum(CALL_DIRECTIONS),
      greeting: z.string().optional(),
      startedAt: z.number(),
      confirmedAt: z.number(),
      spoken: z.boolean(),
      hangUp: z.boolean().optional(),
    }),
  ),
  ended: z.array(z.string()),
});

const digest = (token: string) => createHash("sha256").update(token).digest();

const unavailableLines = (config: VoiceGatewayConfig, bots: Agent[]) =>
  config.lines.flatMap((line) => {
    const bot = bots.find((candidate) => candidate.id === line.botId);

    return bot?.enabled
      ? []
      : [
          {
            username: line.username,
            reason: bot ? ("botDisabled" as const) : ("botDeleted" as const),
          },
        ];
  });

const servedLines = (config: VoiceGatewayConfig, bots: Agent[]) =>
  config.enabled
    ? config.lines.flatMap((line) => {
        const bot = bots.find((candidate) => candidate.id === line.botId);

        return bot?.enabled
          ? [
              {
                username: line.username,
                botId: bot.id,
                botName: bot.name,
                displayName: line.displayName ?? bot.name,
                callsOwner: line.callsOwner,
              },
            ]
          : [];
      })
    : [];

/** Carries the token hash and line generation its request was checked against. */
type VoiceLineStream = {
  hash: string;
  username: string;
  generation: number;
  close: () => void;
};

type VoiceGatewayEvent =
  | { event: "config"; data: VoiceGatewayServedConfig }
  | { event: "call"; data: VoiceCallEvent }
  | { event: "cancel"; data: { callId: string } }
  | { event: "replaced"; data: Record<string, never> };

/** `calls`: the voice gateway declared it places calls, so `call` events go to it. */
type VoiceEventsStream = {
  hash: string;
  calls: boolean;
  send: (message: VoiceGatewayEvent) => void;
  close: () => void;
};

type CallEnd = {
  outcome: Exclude<VoiceCallReport["outcome"], "ringing" | "ended">;
  error?: string | undefined;
};

export type VoiceCallResult =
  | CallEnd
  | { outcome: "refused"; reason: string }
  | { outcome: "unacknowledged" | "timedOut" | "revoked" };

type PendingCall = {
  key: string;
  event: VoiceCallEvent;
  acknowledged: Deferred.Deferred<void>;
  settled: Deferred.Deferred<CallEnd | { outcome: "revoked" }>;
};

/** `key` names the tool call, so running it again never dials again. */
type CallRequest = { key: string; botId: string; greeting: string };

type LiveStream = VoiceEventsStream & { connectedAt: string; openedAt: number };

type VoiceLine = { botId: string; generation: number };

/** Why a call ended: the voice gateway's report, or a lease rule when no report came. */
export type VoiceCallEnd =
  | VoiceCallEndReason
  | "botHungUp"
  | "lost"
  | "revoked"
  | "lineChanged";

/** `spoken`: a spoken message arrived on it. `confirmedAt`: its latest start report. `hangUp`: the bot asked to end it. */
export type VoiceCall = {
  callId: string;
  username: string;
  botId: string;
  direction: CallEventData["direction"];
  greeting?: string | undefined;
  startedAt: number;
  confirmedAt: number;
  spoken: boolean;
  hangUp?: boolean | undefined;
};

/** `wakes`: the end starts a bot turn, unless the bot is disabled. */
export type VoiceCallChange =
  | { phase: "started"; call: VoiceCall }
  | {
      phase: "ended";
      call: VoiceCall;
      reason: VoiceCallEnd;
      endedAt: number;
      wakes: boolean;
    };

type VoiceCallHandler = (change: VoiceCallChange) => Effect.Effect<void>;

export class VoiceGateway extends Context.Service<
  VoiceGateway,
  {
    readonly describe: Effect.Effect<VoiceGatewayDescription>;
    readonly update: (
      config: VoiceGatewayConfig,
    ) => Effect.Effect<VoiceGatewayDescription, InvalidInput>;
    readonly issueToken: Effect.Effect<{ token: string; issuedAt: string }>;
    readonly revokeToken: Effect.Effect<void, NotFound>;
    /** The hash of the current voice gateway token when `token` is that token, without a database read. */
    readonly matchToken: (token: string) => string | null;
    /** The served line and its current generation; NotFound for an unknown line or one whose bot is unavailable. */
    /** Null when the token changed since `hash` was matched. */
    readonly line: (
      username: string,
      hash: string,
    ) => Effect.Effect<VoiceLine | null, NotFound>;
    /** Registers a line stream; null, and the stream closed, when its token or line changed since its request was checked. */
    readonly openLine: (
      stream: VoiceLineStream,
    ) => Effect.Effect<(() => void) | null>;
    /** Makes this the live event stream, replacing an older one, and sends it the config; null, and closed, when its token changed. */
    readonly openEvents: (
      stream: VoiceEventsStream,
    ) => Effect.Effect<(() => void) | null>;
    /** Why `botId` cannot call the owner now, or null when it can. */
    readonly callRefusal: (botId: string) => Effect.Effect<string | null>;
    /** Whether the bot's line has an active call. */
    readonly onCall: (botId: string) => Effect.Effect<boolean>;
    /** Marks the bot's active call to end once its reply was read aloud; false when it has none. */
    readonly hangUp: (botId: string) => Effect.Effect<boolean>;
    /** Whether the bot asked to end the active call on the line. */
    readonly hangingUp: (username: string) => Effect.Effect<boolean>;
    /** Starts the call on the line, or confirms it when active; null when the token changed. */
    readonly startCall: (
      username: string,
      callId: string,
      hash: string,
    ) => Effect.Effect<true | null, NotFound | Conflict>;
    /** The line a spoken message on `callId` reaches; Conflict when that call ended. */
    readonly speak: (
      username: string,
      callId: string,
      hash: string,
    ) => Effect.Effect<VoiceLine | null, NotFound | Conflict>;
    /** Sends a `call` event and waits until the call settles, its wait runs out, or the effect is interrupted, which sends `cancel`. */
    readonly callOwner: (
      request: CallRequest,
    ) => Effect.Effect<VoiceCallResult>;
    /** Null when the token changed since `hash` was matched. */
    readonly reportCall: (
      callId: string,
      report: VoiceCallReport,
      hash: string,
    ) => Effect.Effect<true | null, NotFound>;
    /** Conflict unless the live event stream was opened with `hash`. */
    readonly reportLines: (
      hash: string,
      lines: VoiceLinesReport,
    ) => Effect.Effect<void, Conflict>;
    /** Receives every call start and end once, in order, after the change is made. */
    readonly handleCalls: (
      handler: VoiceCallHandler,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly tick: Effect.Effect<void>;
    readonly start: Effect.Effect<void>;
  }
>()("crumble/voice-gateway/VoiceGateway") {
  static readonly layer = (accountId: string) =>
    Layer.effect(
      VoiceGateway,
      Effect.gen(function* () {
        const settings = yield* SettingsRepository;
        const agents = yield* AgentRepository;
        const scope = yield* Effect.scope;
        // Token changes, config changes, stream registration, and call state take one lock, so nothing lands mid-sweep.
        const changes = yield* Semaphore.make(1);

        let issued: IssuedToken | null =
          issuedToken.safeParse(yield* settings.get(TOKEN_KEY)).data ?? null;

        let served: VoiceGatewayServedConfig | null = null;
        let live: LiveStream | null = null;
        const lineStreams = new Set<VoiceLineStream>();
        const generations = new Map<string, number>();
        const pending = new Map<string, PendingCall>();
        const placed = new Set<string>();
        let lineReport: VoiceLinesReport = [];
        let goneAt: number | null = null;

        const stored = storedCalls.safeParse(
          yield* settings.get(CALLS_KEY),
        ).data;

        const active = new Map<string, VoiceCall>(
          stored?.active.map((call) => [call.username, call]),
        );

        const ended = new Set<string>(stored?.ended);
        // A reloaded call waits for the voice gateway from the first tick on.
        let reloaded = active.size > 0;
        let unsaved = false;
        const calls: VoiceCallChange[] = [];
        let handler: VoiceCallHandler | undefined;
        let announcing = false;

        const generation = (username: string) => generations.get(username) ?? 0;

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

          return settings.set(CALLS_KEY, {
            active: [...active.values()].map(
              ({ greeting, hangUp, ...call }) => ({
                ...call,
                ...(greeting !== undefined && { greeting }),
                ...(hangUp !== undefined && { hangUp }),
              }),
            ),
            ended: [...ended],
          });
        });

        // Call changes are saved under the lock, then announced after it, so a marker never holds the lock.
        const locked = <A, E>(effect: Effect.Effect<A, E>) =>
          Semaphore.withPermit(changes, Effect.ensuring(effect, save)).pipe(
            Effect.ensuring(announce),
          );

        const activeCall = (callId: string) =>
          [...active.values()].find((call) => call.callId === callId);

        const tombstone = (callId: string) => {
          ended.add(callId);
          unsaved = true;

          for (const id of ended) {
            if (ended.size <= KEPT_ENDED) return;
            ended.delete(id);
          }
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
              reason !== "revoked" &&
              (call.direction === "outbound" || call.spoken),
          });
        };

        const settlePending = (call: PendingCall, settled: CallEnd) => {
          pending.delete(call.event.callId);
          Deferred.doneUnsafe(call.acknowledged, Effect.void);
          Deferred.doneUnsafe(call.settled, Effect.succeed(settled));
        };

        // The ID is tombstoned, so a start report still on its way cannot begin the call.
        const cancel = (callId: string) => {
          tombstone(callId);

          if (live?.calls) live.send({ event: "cancel", data: { callId } });
        };

        const config = Effect.map(
          settings.get(CONFIG_KEY),
          (stored) =>
            voiceGatewayConfigInput.safeParse(stored).data ??
            defaultVoiceGatewayConfig(),
        );

        const closeLine = (username: string) => {
          for (const stream of lineStreams)
            if (stream.username === username) {
              lineStreams.delete(stream);
              stream.close();
            }
        };

        const closeAll = (now: number) => {
          for (const call of active.values()) end(call, "revoked", now);

          for (const stream of lineStreams) stream.close();
          lineStreams.clear();
          live?.close();
          live = null;
          lineReport = [];

          for (const call of pending.values()) {
            Deferred.doneUnsafe(call.acknowledged, Effect.void);
            Deferred.doneUnsafe(
              call.settled,
              Effect.succeed({ outcome: "revoked" as const }),
            );
          }

          pending.clear();
        };

        const reassign = (
          username: string,
          botId: string | undefined,
          now: number,
        ) => {
          generations.set(username, generation(username) + 1);
          closeLine(username);
          const call = active.get(username);

          // The first sweep after a restart sees every line as new; a reloaded call stays with its bot.
          if (call && call.botId !== botId) end(call, "lineChanged", now);

          // A ringing call belongs to the bot that placed it, not to the line's next bot.
          for (const ringing of pending.values())
            if (ringing.event.username === username) {
              cancel(ringing.event.callId);
              settlePending(ringing, {
                outcome: "failed",
                error: LINE_CHANGED,
              });
            }
        };

        const reconcile = Effect.gen(function* () {
          const current = yield* config;
          const now = yield* Clock.currentTimeMillis;

          const next: VoiceGatewayServedConfig = {
            enabled: current.enabled,
            ownerNumbers: current.ownerNumbers,
            lines: servedLines(current, yield* agents.list),
          };

          const previous = served;

          const before = new Map(
            previous?.lines.map((line) => [line.username, line.botId] as const),
          );

          const after = new Map(
            next.lines.map((line) => [line.username, line.botId] as const),
          );

          served = next;

          for (const username of new Set([...before.keys(), ...after.keys()]))
            if (before.get(username) !== after.get(username))
              reassign(username, after.get(username), now);

          if (live && JSON.stringify(previous) !== JSON.stringify(next))
            live.send({ event: "config", data: next });

          return next;
        });

        const describe = Effect.gen(function* () {
          const current = yield* config;

          const description: VoiceGatewayDescription = {
            config: current,
            token: issued && { issuedAt: issued.issuedAt },
            status: live ? "connected" : "disconnected",
            connectedAt: live?.connectedAt ?? null,
            lines: lineReport,
            unavailableLines: unavailableLines(current, yield* agents.list),
          };

          return description;
        });

        const update = Effect.fn("VoiceGateway.update")(function* (
          input: VoiceGatewayConfig,
        ) {
          for (const line of input.lines)
            if (!(yield* agents.get(line.botId)))
              return yield* new InvalidInput({
                message: `Unknown bot ${line.botId}`,
              });

          yield* locked(
            Effect.andThen(settings.set(CONFIG_KEY, input), reconcile),
          );

          return yield* describe;
        });

        const issueToken = locked(
          Effect.gen(function* () {
            const token = `${accountId}.${randomBytes(32).toString("base64url")}`;

            const next = {
              hash: digest(token).toString("hex"),
              issuedAt: yield* nowIso,
            };

            yield* settings.set(TOKEN_KEY, next);
            issued = next;
            closeAll(yield* Clock.currentTimeMillis);

            return { token, issuedAt: next.issuedAt };
          }),
        ).pipe(Effect.withSpan("VoiceGateway.issueToken"));

        const revokeToken = locked(
          Effect.gen(function* () {
            if (!(yield* settings.delete(TOKEN_KEY)))
              return yield* new NotFound({
                message: "No voice gateway token is issued",
              });

            issued = null;
            closeAll(yield* Clock.currentTimeMillis);
          }),
        ).pipe(Effect.withSpan("VoiceGateway.revokeToken"));

        const matchToken = (token: string) =>
          issued &&
          timingSafeEqual(digest(token), Buffer.from(issued.hash, "hex"))
            ? issued.hash
            : null;

        const lineIn = (
          current: VoiceGatewayServedConfig,
          username: string,
          hash: string,
        ) => {
          const found = current.lines.find(
            (candidate) => candidate.username === username,
          );

          if (issued?.hash !== hash) return Effect.succeed(null);

          return found
            ? Effect.succeed({
                botId: found.botId,
                generation: generation(username),
              })
            : Effect.fail(new NotFound({ message: "Unknown line" }));
        };

        const line = (username: string, hash: string) =>
          locked(
            Effect.flatMap(reconcile, (current) =>
              lineIn(current, username, hash),
            ),
          );

        const openLine = (stream: VoiceLineStream) =>
          locked(
            Effect.sync(() => {
              if (
                issued?.hash !== stream.hash ||
                generation(stream.username) !== stream.generation
              ) {
                stream.close();

                return null;
              }

              lineStreams.add(stream);

              return () => {
                lineStreams.delete(stream);
              };
            }),
          );

        const openEvents = (stream: VoiceEventsStream) =>
          locked(
            Effect.gen(function* () {
              if (issued?.hash !== stream.hash) {
                stream.close();

                return null;
              }

              const current = yield* reconcile;

              if (live) {
                live.send({ event: "replaced", data: {} });
                live.close();
                lineReport = [];
              }

              const clock = yield* Clock.Clock;

              const opened: LiveStream = {
                ...stream,
                connectedAt: yield* nowIso,
                openedAt: clock.currentTimeMillisUnsafe(),
              };

              live = opened;
              goneAt = null;
              opened.send({ event: "config", data: current });

              if (opened.calls)
                for (const call of pending.values())
                  if (!Deferred.isDoneUnsafe(call.acknowledged))
                    opened.send({ event: "call", data: call.event });

              return () => {
                if (live !== opened) return;
                live = null;
                goneAt = clock.currentTimeMillisUnsafe();
                lineReport = [];
              };
            }),
          );

        const callTarget = (
          current: VoiceGatewayServedConfig,
          botId: string,
        ) => {
          const found = current.lines.find((served) => served.botId === botId);

          const refused = (refusal: string) => ({ refusal, target: null });

          if (!current.enabled)
            return refused("The voice gateway is disabled.");

          if (!found) return refused("You have no line.");

          if (!found.callsOwner)
            return refused(
              "Calls to the owner are switched off for your line.",
            );

          if (!live?.calls)
            return refused(
              "No voice gateway that can place calls is connected.",
            );

          if (active.has(found.username))
            return refused("You are on a call with the owner now.");

          if (
            [...pending.values()].some(
              (call) => call.event.username === found.username,
            )
          )
            return refused("A call to the owner is already ringing.");

          return {
            refusal: null,
            target: { username: found.username, to: current.ownerNumbers[0]! },
          };
        };

        const callRefusal = (botId: string) =>
          locked(
            Effect.map(
              reconcile,
              (current) => callTarget(current, botId).refusal,
            ),
          );

        const callOf = (botId: string) =>
          [...active.values()].find((call) => call.botId === botId);

        const onCall = (botId: string) =>
          Effect.sync(() => callOf(botId) !== undefined);

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

        // A pending call's key stays, so its tool call can never dial twice.
        const forgetPlaced = () => {
          const kept = new Set([...pending.values()].map((call) => call.key));

          for (const key of placed) {
            if (placed.size <= KEPT_PLACED) return;

            if (!kept.has(key)) placed.delete(key);
          }
        };

        const place = (request: CallRequest) =>
          locked(
            Effect.gen(function* () {
              if (placed.has(request.key))
                return { refusal: "This call was already placed.", call: null };

              const { refusal, target } = callTarget(
                yield* reconcile,
                request.botId,
              );

              if (!target) return { refusal, call: null };
              placed.add(request.key);
              forgetPlaced();

              const call: PendingCall = {
                key: request.key,
                event: {
                  callId: crypto.randomUUID(),
                  ...target,
                  greeting: request.greeting,
                },
                acknowledged: yield* Deferred.make<void>(),
                settled: yield* Deferred.make<
                  CallEnd | { outcome: "revoked" }
                >(),
              };

              pending.set(call.event.callId, call);
              live?.send({ event: "call", data: call.event });

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
            Effect.map(
              Option.getOrElse(() => ({ outcome: "timedOut" as const })),
            ),
          );

        const callOwner = Effect.fn("VoiceGateway.callOwner")(function* (
          request: CallRequest,
        ) {
          const { refusal, call } = yield* place(request);

          if (!call) return { outcome: "refused" as const, reason: refusal };

          return yield* settle(call).pipe(Effect.ensuring(drop(call)));
        });

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
              const found = yield* lineIn(yield* reconcile, username, hash);

              if (!found) return null;

              if (ended.has(callId))
                return yield* new Conflict({ message: "The call ended" });

              return yield* use(found, active.get(username));
            }),
          );

        const busy = (
          username: string,
          callId: string,
          placed: PendingCall | undefined,
        ) =>
          active.has(username) ||
          activeCall(callId) !== undefined ||
          (placed !== undefined && placed.event.username !== username);

        const begin = (
          username: string,
          callId: string,
          found: VoiceLine,
          now: number,
        ) => {
          const placed = pending.get(callId);

          if (busy(username, callId, placed))
            return Effect.fail(
              new Conflict({ message: "Another call is active on the line" }),
            );

          if (placed) settlePending(placed, { outcome: "answered" });

          const call: VoiceCall = {
            callId,
            username,
            botId: found.botId,
            direction: placed ? "outbound" : "inbound",
            greeting: placed?.event.greeting,
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

        const speak = (username: string, callId: string, hash: string) =>
          onCallLine(username, callId, hash, (found, current) =>
            Effect.sync(() => {
              if (current?.callId === callId && !current.spoken) {
                current.spoken = true;
                unsaved = true;
              }

              return found;
            }),
          );

        const reportEnded = (
          callId: string,
          report: Extract<VoiceCallReport, { outcome: "ended" }>,
          now: number,
        ) => {
          const started = activeCall(callId);
          const call = pending.get(callId);

          if (started)
            end(
              started,
              started.hangUp && report.reason === "hungUp"
                ? "botHungUp"
                : report.reason,
              now,
            );
          else tombstone(callId);

          if (call)
            settlePending(call, { outcome: "failed", error: report.error });
        };

        const reportCall = (
          callId: string,
          report: VoiceCallReport,
          hash: string,
        ) =>
          locked(
            Effect.gen(function* () {
              if (issued?.hash !== hash) return null;
              const call = pending.get(callId);

              if (report.outcome === "ended") {
                reportEnded(callId, report, yield* Clock.currentTimeMillis);

                return true as const;
              }

              if (!call) {
                if (activeCall(callId)) return true as const;

                return yield* new NotFound({ message: "Unknown call" });
              }

              Deferred.doneUnsafe(call.acknowledged, Effect.void);

              if (report.outcome !== "ringing")
                settlePending(call, {
                  outcome: report.outcome,
                  error: report.error,
                });

              return true as const;
            }),
          );

        const reportLines = (hash: string, lines: VoiceLinesReport) =>
          locked(
            Effect.gen(function* () {
              if (live?.hash !== hash)
                return yield* new Conflict({
                  message: "Open /v1/voice/events before reporting lines",
                });
              lineReport = lines;
            }),
          );

        // A call the voice gateway can no longer report ends here: its stream is gone, or a new one never confirmed it.
        const expire = (now: number) => {
          if (reloaded) {
            reloaded = false;

            if (!live) goneAt = now;
          }

          for (const call of active.values()) {
            const unconfirmed = live
              ? call.confirmedAt < live.openedAt &&
                now - live.openedAt >= RECONFIRM_WITHIN_MS
              : now - Math.max(goneAt ?? 0, call.confirmedAt) >=
                RECONNECT_WITHIN_MS;

            if (unconfirmed || now - call.startedAt >= CALL_LASTS_MS)
              end(call, "lost", now);
          }
        };

        const tick = Effect.suspend(() =>
          live || lineStreams.size || active.size
            ? locked(
                Effect.gen(function* () {
                  yield* reconcile;
                  expire(yield* Clock.currentTimeMillis);
                }),
              )
            : Effect.void,
        );

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

        return VoiceGateway.of({
          describe,
          update,
          issueToken,
          revokeToken,
          matchToken,
          line,
          openLine,
          openEvents,
          callRefusal,
          onCall,
          hangUp,
          hangingUp,
          callOwner,
          startCall,
          speak,
          reportCall,
          reportLines,
          handleCalls,
          tick,
          start: startTicking(tick, scope),
        });
      }),
    );
}
