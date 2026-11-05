import { bodyLimit } from "hono/body-limit";
import type { Env, MiddlewareHandler } from "hono";
import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import { z } from "zod";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { MAX_MESSAGE_BODY } from "../shared/attachment-rules";

/** A route's JSON body schema; a body the contract leaves optional is the handler's to read. */
const requiredBody = (definition: RouteConfig) => {
  const body = definition.request?.body;
  const media = body?.required ? body.content["application/json"] : undefined;
  const schema = media && "schema" in media ? media.schema : undefined;

  return schema instanceof z.ZodType ? schema : undefined;
};

type RequestObject = z.ZodType<object> | undefined;

/** Parses what the route's contract declares, for `c.req.valid`. A `ZodError` becomes the 400 in `handleApiError`. */
const validated = (
  definition: RouteConfig,
  body: z.ZodType | undefined,
): MiddlewareHandler => {
  // SAFETY: a contract's params, query, and JSON bodies are all objects.
  const { params, query, json } = {
    params: definition.request?.params as RequestObject,
    query: definition.request?.query as RequestObject,
    json: body as RequestObject,
  };

  return async (c, next) => {
    if (params) c.req.addValidatedData("param", params.parse(c.req.param()));

    if (query) c.req.addValidatedData("query", query.parse(c.req.query()));

    if (json) c.req.addValidatedData("json", json.parse(await c.req.json()));

    await next();
  };
};

/** Registers a route behind its contract's request schemas. */
export const pathRegister =
  <E extends Env>(app: OpenAPIHono<E>): Register<E> =>
  (definition, handler, options) => {
    const body = options?.parsesBody ? undefined : requiredBody(definition);

    app.openAPIRegistry.registerPath(definition);
    app.on(
      definition.method,
      definition.getRoutingPath(),
      validated(definition, body),
      handler,
    );
  };

const messagePaths = [routes.sendMessage, routes.sendGroupMessage].map(
  (route) =>
    new RegExp(`^${route.getRoutingPath().replace(/:[^/]+/g, "[^/]+")}$`),
);

/** Messages may carry attachments; every other request stays small. */
export const limitBodies = <E extends Env>(app: OpenAPIHono<E>) => {
  const messageBodyLimit = bodyLimit({ maxSize: MAX_MESSAGE_BODY });
  const defaultBodyLimit = bodyLimit({ maxSize: 1024 * 1024 });

  app.use("*", (c, next) =>
    c.req.method === "POST" &&
    messagePaths.some((path) => path.test(c.req.path))
      ? messageBodyLimit(c, next)
      : defaultBodyLimit(c, next),
  );
};
