import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Clock, Context, Effect, Layer, type Scope } from "effect";
import { z } from "zod";
import { AgentRepository } from "../bot-store/agent-repository";
import type { Agent } from "../contract/agents";
import {
  defaultVoiceGatewayConfig,
  voiceGatewayConfigInput,
  type CallParty,
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
import { createCallState } from "./call-state";
import type {
  CallRequest,
  LineRoute,
  OutsideCallRequest,
  VoiceCallHandler,
  VoiceCallResult,
  VoiceLine,
} from "./call-types";

export type {
  LineRoute,
  OutsideCall,
  OutsideCallMiss,
  VoiceCall,
  VoiceCallChange,
  VoiceCallEnd,
  VoiceCallResult,
} from "./call-types";

const CONFIG_KEY = "voice-gateway";
const TOKEN_KEY = "voice-gateway:token";

const issuedToken = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/u),
  issuedAt: z.string(),
});

type IssuedToken = z.infer<typeof issuedToken>;

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

type LiveStream = VoiceEventsStream & { connectedAt: string; openedAt: number };

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
    /** Why `botId` cannot place an outside call now, worded for the owner, or null when it can. */
    readonly othersRefusal: (botId: string) => Effect.Effect<string | null>;
    /** Whether the bot's line may call people other than the owner. */
    readonly callsOthers: (botId: string) => Effect.Effect<boolean>;
    /** Who the bot's line has an active call with, or null without one; `callee` names an outside call's. */
    readonly currentCall: (
      botId: string,
    ) => Effect.Effect<{ party: CallParty; callee?: string } | null>;
    readonly isActive: (callId: string) => Effect.Effect<boolean>;
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
    /** Where a message on `callId` goes; Conflict when that call ended, or is an outside call that is not the line's active call. */
    readonly speak: (
      username: string,
      callId: string,
      hash: string,
    ) => Effect.Effect<LineRoute | null, NotFound | Conflict>;
    /**
     * Where the line's turns go: to the active outside call's conversation when `callId` is it, or, without `callId`,
     * while the line has one. Conflict for an outside call's ID that is not the line's active call.
     */
    readonly route: (
      username: string,
      hash: string,
      callId: string | undefined,
    ) => Effect.Effect<LineRoute | null, NotFound | Conflict>;
    /** Sends a `call` event and waits until the call settles, its wait runs out, or the effect is interrupted, which sends `cancel`. */
    readonly callOwner: (
      request: CallRequest,
    ) => Effect.Effect<VoiceCallResult>;
    /**
     * Stores the outside call's ID, then sends its `call` event; the refusal, or null once sent. It does not wait: the
     * call's settling runs in the service's scope and announces a call that never started as `missed`.
     */
    readonly callOutside: (
      request: OutsideCallRequest,
    ) => Effect.Effect<string | null>;
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
    /** Receives every call start, end, and missed outside call once, in order, after the change is made. */
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

        let issued: IssuedToken | null =
          issuedToken.safeParse(yield* settings.get(TOKEN_KEY)).data ?? null;

        let served: VoiceGatewayServedConfig | null = null;
        let live: LiveStream | null = null;
        const lineStreams = new Set<VoiceLineStream>();
        const generations = new Map<string, number>();
        let lineReport: VoiceLinesReport = [];
        let othersAllowed = new Set<string>();

        const calls = yield* createCallState(settings, scope, {
          reconcile: () => reconcile,
          line: (current, username, hash) => lineIn(current, username, hash),
          acceptsToken: (hash) => issued?.hash === hash,
          connection: () => live,
          allowsOthers: (username) => othersAllowed.has(username),
        });

        const { locked } = calls;

        const generation = (username: string) => generations.get(username) ?? 0;

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
          calls.endAll(now);

          for (const stream of lineStreams) stream.close();
          lineStreams.clear();
          live?.close();
          live = null;
          lineReport = [];

          calls.revokePending();
        };

        const reassign = (
          username: string,
          botId: string | undefined,
          now: number,
        ) => {
          generations.set(username, generation(username) + 1);
          closeLine(username);
          calls.reassign(username, botId, now);
        };

        const reconcile = Effect.gen(function* () {
          const current = yield* config;
          const now = yield* Clock.currentTimeMillis;

          const next: VoiceGatewayServedConfig = {
            enabled: current.enabled,
            ownerNumbers: current.ownerNumbers,
            lines: servedLines(current, yield* agents.list),
          };

          othersAllowed = new Set(
            current.lines.flatMap((line) =>
              line.callsOthers ? [line.username] : [],
            ),
          );

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
              calls.connected();
              opened.send({ event: "config", data: current });

              if (opened.calls) calls.replay();

              return () => {
                if (live !== opened) return;
                live = null;
                calls.disconnected(clock.currentTimeMillisUnsafe());
                lineReport = [];
              };
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

        const tick = Effect.suspend(() =>
          live || lineStreams.size || calls.hasActive()
            ? locked(
                Effect.gen(function* () {
                  yield* reconcile;
                  calls.expire(yield* Clock.currentTimeMillis);
                }),
              )
            : Effect.void,
        );

        return VoiceGateway.of({
          ...calls.api,
          describe,
          update,
          issueToken,
          revokeToken,
          matchToken,
          line,
          openLine,
          openEvents,
          reportLines,
          tick,
          start: startTicking(tick, scope),
        });
      }),
    );
}
