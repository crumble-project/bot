import { Effect } from "effect";
import type { Bots } from "../bots/bots";
import type { CallEventData } from "../transcript/entries";

/** Wakes the bot with a call's end line, or, when it does not wake or the bot is disabled, writes it as a marker. */
export const endNotice = Effect.fnUntraced(function* (
  bots: Bots["Service"],
  botId: string,
  marker: CallEventData & { phase: "ended"; text: string },
  requestId: string,
  wakes: boolean,
) {
  const enabled = Effect.map(bots.agent(botId), (bot) => bot.enabled);

  if (wakes && (yield* enabled)) {
    // A bot disabled since the check refuses the notice; its marker is still due.
    const woken = yield* bots.notice(botId, marker.text, requestId).pipe(
      Effect.as(true),
      Effect.catchTag("Conflict", (refused) =>
        Effect.flatMap(enabled, (still) =>
          still ? Effect.fail(refused) : Effect.succeed(false),
        ),
      ),
    );

    if (woken) return;
  }

  yield* bots.recordCallEvent(botId, marker, requestId);
});
