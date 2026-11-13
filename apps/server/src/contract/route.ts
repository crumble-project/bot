import {
  createRoute,
  z,
  type RouteConfig,
  type RouteHandler,
} from "@hono/zod-openapi";
import type { Effect } from "effect";
import type { Env } from "hono";

/**
 * Registers a contract route's handler on the API app, behind the route's request schemas. `parsesBody` leaves the
 * body to a handler that must read it first, such as a PATCH that merges it over the stored record.
 */
export type EffectRouteHandler<
  R extends RouteConfig,
  E extends Env = Env,
  S = never,
> = (
  c: Parameters<RouteHandler<R, E>>[0],
) => Generator<
  Effect.Effect<unknown, unknown, S>,
  Awaited<ReturnType<RouteHandler<R, E>>>,
  never
>;

export type PlainRegister<E extends Env = Env> = <R extends RouteConfig>(
  definition: R & { getRoutingPath: () => string },
  handler: RouteHandler<R, E>,
  options?: { parsesBody: true },
) => void;

export type Register<E extends Env = Env, S = never> = (<R extends RouteConfig>(
  definition: R & { getRoutingPath: () => string },
  handler: EffectRouteHandler<R, E, S>,
  options?: { parsesBody: true },
) => void) & {
  plain: PlainRegister<E>;
};

export const mergedBody = async <S extends z.ZodType>(
  c: { req: { json(): Promise<object> } },
  stored: Partial<z.input<S>>,
  schema: S,
): Promise<z.output<S>> => schema.parse({ ...stored, ...(await c.req.json()) });

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

/** A route under `/v1/voice/`: only a voice gateway token reaches it, never a session. */
export function defineVoiceGateway<const R extends RouteConfig>(config: R) {
  const security: NonNullable<RouteConfig["security"]> = [
    { VoiceGatewayToken: [] },
  ];

  return createRoute({
    ...config,
    security,
    responses: {
      ...errors,
      401: json(error, "Missing, revoked, or replaced voice gateway token"),
      ...config.responses,
    },
  });
}
