import { Effect } from "effect";
import type { Bots } from "../bots/bots";
import type { CallEventData } from "../transcript/entries";

export const endNotice = Effect.fnUntraced(function* (
  bots: Bots["Service"],
  botId: string,
  marker: CallEventData & { phase: "ended"; text: string },
  requestId: string,
  wakes: boolean,
) {
  const enabled = Effect.map(bots.agent(botId), (bot) => bot.enabled);

  if (wakes && (yield* enabled)) {
    const woken = yield* bots.notice(botId, marker.text, requestId).pipe(
      Effect.as(true),
      Effect.catchTag("Conflict", (refused) =>
        Effect.flatMap(enabled, (still) =>
          still ? Effect.fail(refused) : Effect.succeed(false),
        ),
      ),
    );

    if (woken) {
      return;
    }
  }

  yield* bots.recordCallEvent(botId, marker, requestId);
});
