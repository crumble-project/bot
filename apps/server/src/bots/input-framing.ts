import {
  eventRelayText,
  type ScriptEvent,
} from "../event-sources/event-payload";
import { parseRequestId } from "../shared/request-ids";
import { messageTag, type InputOrigin } from "../transcript/origins";

// A relayed job question says itself how to answer; a plain reply never reaches the job.
function botRelayText(
  origin: Extract<InputOrigin, { kind: "bot" }>,
  text: string,
  requestId: string,
) {
  const from = `Message from bot ${JSON.stringify(origin.name)} (${origin.agentId}):\n\n${text}`;

  return parseRequestId(requestId).kind === "job-question"
    ? from
    : `${from}\n\nReply to this bot's message. Your answer will be returned to the requesting bot.`;
}

/**
 * What the model reads of an input: its text, said to come from another bot or tagged so the bot can cite it, and an
 * event automation's event, which follows in the model's input and never in the stored text.
 */
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
