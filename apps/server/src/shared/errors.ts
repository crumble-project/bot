import { Predicate, Schema } from "effect";

/** The request asks for something invalid, such as an empty memory or a bot that is not a member. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  { message: Schema.String },
) {}

/** The bot or owner may not do this, such as message a bot it has no permission for. */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

/** The thing exists but cannot be changed, such as a bundled skill. */
export class ReadOnly extends Schema.TaggedError<ReadOnly>()("ReadOnly", {
  message: Schema.String,
}) {}

/** The request collides with the current state, such as a request ID reused for another message. */
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
}) {}

/** A request ID names one message, whichever chat or group it reached. */
export const REQUEST_ID_REUSED =
  "Request ID already used for a different message";

/** The thing existed but is over, such as a finished provider sign-in. */
export class Gone extends Schema.TaggedError<Gone>()("Gone", {
  message: Schema.String,
}) {}

/** The server cannot do this now, such as when a feature is not configured. */
export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  { message: Schema.String },
) {}

/** A thrown value's message; without one, `fallback`, or the value itself as text. */
export const errorText = (cause: unknown, fallback = String(cause)) =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : fallback;

/** A failure the owner or bot can act on; anything else is a defect. */
/** A failure the owner or bot can act on; anything else is a defect. */
export type AppError =
  | InvalidInput
  | Forbidden
  | NotFound
  | ReadOnly
  | Conflict
  | Gone
  | Unavailable;

const statuses = {
  InvalidInput: 400,
  Forbidden: 403,
  NotFound: 404,
  ReadOnly: 405,
  Conflict: 409,
  Gone: 410,
  Unavailable: 503,
} as const satisfies Record<AppError["_tag"], number>;

export const isAppError = (value: unknown): value is AppError =>
  Predicate.hasProperty(value, "_tag") &&
  Predicate.isString(value._tag) &&
  Object.hasOwn(statuses, value._tag) &&
  value instanceof Error;

/** The HTTP status the API answers an AppError with. */
export const httpStatus = (error: AppError) => statuses[error._tag];
