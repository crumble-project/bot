import {
  eventRelayText,
  type ScriptEvent,
} from "../event-sources/event-payload";
import { parseRequestId } from "../shared/request-ids";
import { messageTag, type InputOrigin } from "../transcript/origins";

function botRelayText(
  origin: Extract<InputOrigin, { kind: "bot" }>,
  text: string,
  requestId: string,
) {
  const from = `Message from bot ${JSON.stringify(origin.name)} (${origin.agentId}):\n\n${text}`;

  return parseRequestId(requestId).kind === "job-question"
    ? from
    : `${from}\n\nReply to this bot's message. Your answer will be returned to that bot.`;
}

export function frameInput(
  text: string,
  origin: InputOrigin,
  requestId: string,
  event?: ScriptEvent,
) {
  const framed =
    origin.kind === "bot"
      ? botRelayText(origin, text, requestId)
      : messageTag(origin.kind, requestId, text);

  return event
    ? eventRelayText(framed, event.record, event.sourceName)
    : framed;
}
