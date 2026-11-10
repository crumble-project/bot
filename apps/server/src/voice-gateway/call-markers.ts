import { Effect, Layer } from "effect";
import { Bots } from "../bots/bots";
import { logged } from "../shared/app-errors";
import { voiceCallRequest } from "../shared/request-ids";
import { CallRequests } from "./call-requests";
import { endNotice } from "./call-notices";
import { callEndedText } from "./call-text";
import { markOutsideCall } from "./outside-calls";
import { VoiceGateway, type VoiceCallChange } from "./voice-gateway";

const mark = Effect.fnUntraced(function* (
  bots: Bots["Service"],
  change: Exclude<VoiceCallChange, { phase: "missed" }>,
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

  yield* endNotice(
    bots,
    botId,
    { callId, phase: "ended", direction, text },
    voiceCallRequest(callId, "ended"),
    change.wakes,
  );
});

/** Writes each call's markers into its bot's chat, and wakes the bot when a call ends. */
export const callMarkers = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* VoiceGateway;
    const bots = yield* Bots;
    const requests = yield* CallRequests;

    yield* gateway.handleCalls((change) =>
      Effect.gen(function* () {
        if (yield* markOutsideCall({ bots, requests }, change)) return;

        if (change.phase !== "missed") yield* mark(bots, change);
      }).pipe(
        logged(
          "Voice call marker failed",
          change.call.botId,
          change.call.callId,
        ),
      ),
    );
  }),
);
