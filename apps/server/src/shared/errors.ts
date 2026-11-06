import { Predicate, Schema } from "effect";

export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  { message: Schema.String },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

export class ReadOnly extends Schema.TaggedError<ReadOnly>()("ReadOnly", {
  message: Schema.String,
}) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
}) {}

export const REQUEST_ID_REUSED =
  "Request ID already used for a different message";

export class Gone extends Schema.TaggedError<Gone>()("Gone", {
  message: Schema.String,
}) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  { message: Schema.String },
) {}

export const errorText = (cause: unknown, fallback = String(cause)) =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : fallback;

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

export const httpStatus = (error: AppError) => statuses[error._tag];
