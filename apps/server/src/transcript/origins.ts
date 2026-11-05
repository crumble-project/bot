import type { Execution, OWNER_MESSAGE_SOURCES } from "../shared/domain";
import type { JobKindName } from "../shared/job-kinds";
import { askingBot, parseRequestId } from "../shared/request-ids";

/** The name a bot's message shows once that bot is gone. */
export const UNKNOWN_BOT_NAME = "Another bot";

/** The name a scheduled turn shows once its automation is gone. */
export const UNKNOWN_SCHEDULE_NAME = "Scheduled task";

/**
 * Every origin Crumble writes on an input. Stored entries and the wire keep `kind` a plain string, as clients may see
 * values they don't know, so this type holds for writes only: reads get `MessageOrigin`.
 */
export type InputOrigin =
  | { kind: "owner"; via?: string }
  | { kind: "group" }
  | { kind: "task"; name: string }
  | { kind: "event"; name: string; source: string }
  | { kind: "script"; name: string }
  | { kind: "bot"; agentId: string; name: string }
  | { kind: "credential"; name: string }
  | { kind: "bot_request" }
  | { kind: "review" }
  | { kind: JobKindName; name: string };

export const isBotOrigin = (origin: { kind: string } | undefined) =>
  origin?.kind === "bot";

export const isOwnerOrigin = (origin: { kind: string } | undefined) =>
  origin?.kind === "owner";

/**
 * Whose request each origin's words are: the owner's own, or the instructions of an automation the owner set up. A
 * script automation's notice is not one: it carries the command's output, which anyone the script reads can write.
 * An event automation's stored text is its prompt alone; the event's payload reaches only the model.
 */
const REQUEST_SOURCES: Record<
  InputOrigin["kind"],
  (typeof OWNER_MESSAGE_SOURCES)[number] | undefined
> = {
  owner: "owner",
  task: "automation",
  event: "automation",
  group: undefined,
  script: undefined,
  bot: undefined,
  credential: undefined,
  bot_request: undefined,
  review: undefined,
  coding: undefined,
  desktop: undefined,
};

/** Who asked for a message of `originKind`, when a job may cite it; a stored kind can be one this server doesn't know. */
export const requestSource = (originKind: string) =>
  new Map(Object.entries(REQUEST_SOURCES)).get(originKind);

/** Prefixes an owner or automation message in the bot's model context, so the bot can cite it in `owner_messages`. */
export const messageTag = (
  originKind: string,
  requestId: string,
  text: string,
) => (requestSource(originKind) ? `[message ${requestId}]\n${text}` : text);

/** Where a turn came from, as far as its execution says without looking anything up. */
export type TurnSource =
  | { kind: "group" }
  | { kind: "event"; eventId: string; scheduleId: string }
  | { kind: "task"; scheduleId: string }
  | { kind: "bot"; agentId: string }
  | { kind: "script"; scheduleId: string }
  // Origins document no login kind, and clients label a login like a credential.
  | { kind: "credential"; name: string }
  | { kind: "bot_request" }
  | { kind: "owner"; via?: string };

export function turnSource({
  requestId,
  scheduleId,
}: Pick<Execution, "requestId" | "scheduleId">): TurnSource {
  const request = parseRequestId(requestId);

  if (request.kind === "group-turn") return { kind: "group" };

  if (request.kind === "event") return request;

  if (scheduleId) return { kind: "task", scheduleId };

  const asking = askingBot(request);

  if (asking) return { kind: "bot", agentId: asking };

  switch (request.kind) {
    case "script":
      return { kind: "script", scheduleId: request.scheduleId };
    case "notice":
      return { kind: "credential", name: request.name };
    case "bot-request":
      return { kind: "bot_request" };
    case "gateway":
      return { kind: "owner", via: request.adapterId };
    default:
      return { kind: "owner" };
  }
}
