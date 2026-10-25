import { expect, test } from "bun:test";
import {
  Conflict,
  Forbidden,
  Gone,
  httpStatus,
  InvalidInput,
  isAppError,
  NotFound,
  ReadOnly,
  Unavailable,
} from "./errors";

test("each app error answers with the HTTP status it had as an AppError", () => {
  const message = "m";

  expect(
    [
      new InvalidInput({ message }),
      new Forbidden({ message }),
      new NotFound({ message }),
      new ReadOnly({ message }),
      new Conflict({ message }),
      new Gone({ message }),
      new Unavailable({ message }),
    ].map((error) => [isAppError(error), httpStatus(error), error.message]),
  ).toEqual([
    [true, 400, message],
    [true, 403, message],
    [true, 404, message],
    [true, 405, message],
    [true, 409, message],
    [true, 410, message],
    [true, 503, message],
  ]);
});

test("other errors are not app errors", () => {
  expect(isAppError(new Error("x"))).toBe(false);
  expect(isAppError({ _tag: "NotFound", message: "x" })).toBe(false);
});
