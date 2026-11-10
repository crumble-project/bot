import {
  eventRelayText,
  type ScriptEvent,
} from "../event-sources/event-payload";
import { parseRequestId, VOICE_VIA } from "../shared/request-ids";
import { messageTag, type InputOrigin } from "../transcript/origins";

const SPOKEN_NOTE =
  "[Spoken on a phone call. Your reply is read aloud: answer briefly in plain sentences, without lists, tables, code, or links. Saying goodbye does not end the call: when the owner says goodbye or asks you to hang up, call hang_up.]";

const CALL_ENDED_NOTE =
  "This turn is only for what the call left open. If you told the owner you would do something after the call, such as calling them back or a task, do it now. If nothing is pending, react with 👍 and write nothing.";

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

function originText(text: string, origin: InputOrigin, requestId: string) {
  if (origin.kind === "bot") return botRelayText(origin, text, requestId);

  if (origin.kind === "call") return `[${text}]\n${CALL_ENDED_NOTE}`;

  return messageTag(
    origin.kind,
    requestId,
    origin.kind === "owner" && origin.via === VOICE_VIA
      ? `${SPOKEN_NOTE}\n${text}`
      : text,
  );
}

export function frameInput(
  text: string,
  origin: InputOrigin,
  requestId: string,
  event?: ScriptEvent,
) {
  const framed = originText(text, origin, requestId);

  return event
    ? eventRelayText(framed, event.record, event.sourceName)
    : framed;
}
