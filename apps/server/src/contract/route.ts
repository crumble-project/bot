import {
  createRoute,
  z,
  type RouteConfig,
  type RouteHandler,
} from "@hono/zod-openapi";

/** Registers a contract route's handler on the API app. */
export type Register = <R extends RouteConfig>(
  definition: R & { getRoutingPath: () => string },
  handler: RouteHandler<R>,
) => void;

export const json = <S extends z.ZodType>(
  schema: S,
  description = "Success",
) => ({
  description,
  content: { "application/json": { schema } },
});

export const body = <S extends z.ZodType>(schema: S) => ({
  required: true,
  content: { "application/json": { schema } },
});

export const empty = { description: "Success, no response body" };

export const error = z
  .object({
    error: z.string(),
    details: z
      .array(
        z
          .object({
            code: z.string(),
            path: z.array(z.union([z.string(), z.number()])),
            message: z.string(),
          })
          .loose(),
      )
      .optional(),
  })
  .openapi("Error");

const errors = {
  400: json(error, "Invalid request or operation"),
  401: {
    description: "Missing, expired, or invalid account session",
    content: { "text/plain": { schema: z.string() } },
  },
  404: json(error, "Resource not found"),
  405: json(error, "Resource is read-only"),
  409: json(error, "Conflicting request"),
  413: {
    description: "Request body exceeds the size limit",
    content: { "text/plain": { schema: z.string() } },
  },
  500: json(error, "Internal server error"),
  503: json(error, "Service unavailable"),
};

export function define<const R extends RouteConfig>(config: R) {
  const security: NonNullable<RouteConfig["security"]> = [
    { BearerAuth: [] },
    { SessionCookie: [] },
  ];

  return createRoute({
    ...config,
    security,
    responses: { ...errors, ...config.responses },
  });
}
