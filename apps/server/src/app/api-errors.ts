import type { ErrorHandler } from "hono";
import { logError } from "../shared/process-log";
import { HTTPException } from "hono/http-exception";
import { httpStatus, isAppError } from "../shared/errors";
import { isZodError } from "../shared/zod-guards";

export const handleApiError: ErrorHandler = (error, c) => {
  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  if (isZodError(error)) {
    return c.json({ error: "Invalid request", details: error.issues }, 400);
  }

  if (isAppError(error)) {
    return c.json({ error: error.message }, httpStatus(error));
  }

  if (error instanceof SyntaxError) {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  logError(error);

  return c.json({ error: "The server could not complete this request" }, 500);
};
