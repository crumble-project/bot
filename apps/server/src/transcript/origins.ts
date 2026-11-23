import type { Execution, OWNER_MESSAGE_SOURCES } from "../shared/domain";
import type { JobKindName } from "../shared/job-kinds";
import { askingBot, parseRequestId, VOICE_VIA } from "../shared/request-ids";

export const UNKNOWN_BOT_NAME = "Another bot";

export const UNKNOWN_SCHEDULE_NAME = "Deleted automation";

export type InputOrigin =
  | { kind: "owner"; via?: string }
  | { kind: "task"; name: string }
  | { kind: "event"; name: string; source: string }
  | { kind: "script"; name: string }
  | { kind: "bot"; agentId: string; name: string }
  | { kind: "credential"; name: string }
  | { kind: "files" }
  | { kind: "bot_request" }
  | { kind: "review" }
  | { kind: "call" }
  | { kind: "callee"; name: string }
  | { kind: "call_request" }
  | { kind: JobKindName; name: string };

export const isBotOrigin = (origin: { kind: string } | undefined) =>
  origin?.kind === "bot";

export const isOwnerOrigin = (origin: { kind: string } | undefined) =>
  origin?.kind === "owner";

const REQUEST_SOURCES: Record<
  InputOrigin["kind"],
  (typeof OWNER_MESSAGE_SOURCES)[number] | undefined
> = {
  owner: "owner",
  task: "automation",
  event: "automation",
  script: undefined,
  bot: undefined,
  credential: undefined,
  files: undefined,
  bot_request: undefined,
  review: undefined,
  call: undefined,
  callee: undefined,
  call_request: undefined,
  coding: undefined,
  desktop: undefined,
};

export const requestSource = (originKind: string) =>
  new Map(Object.entries(REQUEST_SOURCES)).get(originKind);

export const messageTag = (
  originKind: string,
  requestId: string,
  text: string,
) => (requestSource(originKind) ? `[message ${requestId}]\n${text}` : text);

export type TurnSource =
  | { kind: "event"; eventId: string; scheduleId: string }
  | { kind: "task"; scheduleId: string }
  | { kind: "bot"; agentId: string }
  | { kind: "script"; scheduleId: string }
  | { kind: "credential"; name: string }
  | { kind: "files" }
  | { kind: "bot_request" }
  | { kind: "call" }
  | { kind: "callee" }
  | { kind: "call_request" }
  | { kind: "owner"; via?: string };

export function turnSource({
  requestId,
  scheduleId,
}: Pick<Execution, "requestId" | "scheduleId">): TurnSource {
  const request = parseRequestId(requestId);

  if (request.kind === "event") {
    return request;
  }

  if (scheduleId) {
    return { kind: "task", scheduleId };
  }

  const asking = askingBot(request);

  if (asking) {
    return { kind: "bot", agentId: asking };
  }

  if (request.kind === "script") {
    return { kind: "script", scheduleId: request.scheduleId };
  }

  if (request.kind === "notice") {
    return request.notice === "files"
      ? { kind: "files" }
      : { kind: "credential", name: request.name };
  }

  if (request.kind === "bot-request") {
    return { kind: "bot_request" };
  }

  if (request.kind === "gateway") {
    return { kind: "owner", via: request.adapterId };
  }

  if (request.kind === "voice") {
    return { kind: "owner", via: VOICE_VIA };
  }

  if (request.kind === "voice-call") {
    return { kind: "call" };
  }

  if (request.kind === "outside-call") {
    return { kind: "callee" };
  }

  if (request.kind === "call-request") {
    return { kind: "call_request" };
  }

  return { kind: "owner" };
}
