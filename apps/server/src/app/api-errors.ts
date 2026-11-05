import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { httpStatus, isAppError } from "../shared/errors";

/** Every error leaves as JSON with the status its type maps to, until the last resort. */
export const handleApiError: ErrorHandler = (error, c) => {
  if (error instanceof HTTPException) return error.getResponse();

  if (error instanceof z.ZodError)
    return c.json({ error: "Invalid request", details: error.issues }, 400);

  if (isAppError(error))
    return c.json({ error: error.message }, httpStatus(error));

  if (error instanceof SyntaxError)
    return c.json({ error: "Invalid JSON" }, 400);
  console.error(error);

  return c.json({ error: "The server could not complete this request" }, 500);
};
