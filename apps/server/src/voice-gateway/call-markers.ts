import { Effect, Layer } from "effect";
import { Bots } from "../bots/bots";
import { logged } from "../shared/app-errors";
import { voiceCallRequest } from "../shared/request-ids";
import {
  VoiceGateway,
  type VoiceCallChange,
  type VoiceCallEnd,
} from "./voice-gateway";

const ENDED_BECAUSE: Record<VoiceCallEnd, string | null> = {
  hungUp: null,
  botHungUp: "the bot hung up",
  maxDuration: "it reached its maximum length",
  failed: "the call failed",
  stopping: "the voice gateway stopped",
  lost: "the voice gateway lost its connection",
  revoked: "the voice gateway token was revoked",
  lineChanged: "the line was given to another bot or turned off",
};

const count = (value: number, unit: string) =>
  `${value} ${unit}${value === 1 ? "" : "s"}`;

function lasted(ms: number) {
  const minutes = Math.floor(ms / 60_000);

  if (minutes < 1) return "less than a minute";
  const hours = Math.floor(minutes / 60);

  if (!hours) return count(minutes, "minute");

  return minutes % 60
    ? `${count(hours, "hour")} ${count(minutes % 60, "minute")}`
    : count(hours, "hour");
}

/** The one line both the owner and the woken bot read. */
export function callEndedText(reason: VoiceCallEnd, ms: number) {
  const because = ENDED_BECAUSE[reason];

  return `Call ended after ${lasted(ms)}${because ? `: ${because}` : ""}.`;
}

const mark = Effect.fnUntraced(function* (
  bots: Bots["Service"],
  change: VoiceCallChange,
) {
  const { callId, botId, direction, greeting } = change.call;

  if (change.phase === "started")
    return yield* bots.recordCallEvent(
      botId,
      {
        callId,
        phase: "started",
        direction,
        ...(greeting !== undefined && { greeting }),
      },
      voiceCallRequest(callId, "started"),
    );

  const text = callEndedText(
    change.reason,
    change.endedAt - change.call.startedAt,
  );

  const requestId = voiceCallRequest(callId, "ended");

  const enabled = Effect.map(bots.agent(botId), (bot) => bot.enabled);

  if (change.wakes && (yield* enabled)) {
    // A bot disabled since the check refuses the notice; its marker is still due.
    const woken = yield* bots.notice(botId, text, requestId).pipe(
      Effect.as(true),
      Effect.catchTag("Conflict", (refused) =>
        Effect.flatMap(enabled, (still) =>
          still ? Effect.fail(refused) : Effect.succeed(false),
        ),
      ),
    );

    if (woken) return;
  }

  yield* bots.recordCallEvent(
    botId,
    { callId, phase: "ended", direction, text },
    requestId,
  );
});

/** Writes each call's markers into its bot's chat, and wakes the bot when a call ends. */
export const callMarkers = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* VoiceGateway;
    const bots = yield* Bots;

    yield* gateway.handleCalls((change) =>
      mark(bots, change).pipe(
        logged(
          "Voice call marker failed",
          change.call.botId,
          change.call.callId,
        ),
      ),
    );
  }),
);
