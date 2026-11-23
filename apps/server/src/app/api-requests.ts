import { bodyLimit } from "hono/body-limit";
import type { Context, Env, MiddlewareHandler } from "hono";
import type { OpenAPIHono, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import { Effect, Predicate } from "effect";
import type { z } from "zod";
import { routes } from "../contract/api-contract";
import type {
  EffectRouteHandler,
  PlainRegister,
  Register,
} from "../contract/route";
import { noServices } from "../shared/runner";
import type { Runner } from "../shared/runner";
import { MAX_MESSAGE_BODY } from "../shared/attachment-rules";
import { MAX_FILE_BYTES } from "../files/library";
import { fileName, fileTooLarge } from "../files/files-api";
import { isZodSchema } from "../shared/zod-guards";

const requiredBody = (definition: RouteConfig) => {
  const body = definition.request?.body;
  const media = body?.required ? body.content["application/json"] : undefined;
  const schema = media && "schema" in media ? media.schema : undefined;

  return isZodSchema(schema) ? schema : undefined;
};

/** A contract's params, query, and JSON bodies parse to objects, which is what hono's validated data takes. */
const validatedObject = (schema: z.ZodType, value: unknown) => {
  const parsed = schema.parse(value);

  if (!Predicate.isObject(parsed)) {
    throw new Error("The route's request schema parsed to a non-object");
  }

  return parsed;
};

const validated = (
  definition: RouteConfig,
  body: z.ZodType | undefined,
): MiddlewareHandler => {
  const params = definition.request?.params;
  const query = definition.request?.query;
  const json = body;

  return async (c, next) => {
    if (params) {
      c.req.addValidatedData("param", validatedObject(params, c.req.param()));
    }

    if (query) {
      c.req.addValidatedData("query", validatedObject(query, c.req.query()));
    }

    if (json) {
      c.req.addValidatedData("json", validatedObject(json, await c.req.json()));
    }

    await next();
  };
};

const registerWith = <E extends Env, S>(
  app: OpenAPIHono<E>,
  run: Runner<S>,
): Register<E, S> => {
  const mount = <R extends RouteConfig>(
    definition: R & { getRoutingPath: () => string },
    handler: (
      c: Parameters<RouteHandler<R, E>>[0],
      next: Parameters<RouteHandler<R, E>>[1],
    ) =>
      | ReturnType<RouteHandler<R, E>>
      | Promise<Awaited<ReturnType<RouteHandler<R, E>>>>,
    options?: { parsesBody: true },
  ) => {
    const body = options?.parsesBody ? undefined : requiredBody(definition);

    app.openAPIRegistry.registerPath(definition);
    app.on(
      definition.method,
      definition.getRoutingPath(),
      validated(definition, body),
      handler,
    );
  };

  const plain: PlainRegister<E> = (definition, handler, options) =>
    mount(definition, handler, options);

  const register = <R extends RouteConfig>(
    definition: R & { getRoutingPath: () => string },
    handler: EffectRouteHandler<R, E, S>,
    options?: { parsesBody: true },
  ) =>
    mount(
      definition,
      (c) => run.runPromise(Effect.gen(() => handler(c))),
      options,
    );

  register.plain = plain;

  return register;
};

export function pathRegister<E extends Env>(
  app: OpenAPIHono<E>,
): Register<E, never>;
export function pathRegister<E extends Env, S>(
  app: OpenAPIHono<E>,
  run: Runner<S>,
): Register<E, S>;
export function pathRegister<E extends Env, S>(
  app: OpenAPIHono<E>,
  run?: Runner<S>,
): Register<E, S> | Register<E, never> {
  return run ? registerWith(app, run) : registerWith(app, noServices);
}

const messagePaths = [routes.sendMessage].map(
  (route) =>
    new RegExp(`^${route.getRoutingPath().replaceAll(/:[^/]+/g, "[^/]+")}$`),
);

const uploadPaths = [routes.uploadFile].map(
  (route) =>
    new RegExp(`^${route.getRoutingPath().replaceAll(/:[^/]+/g, "[^/]+")}$`),
);

export const limitBodies = <E extends Env>(app: OpenAPIHono<E>) => {
  const uploadLimit = bodyLimit({
    maxSize: MAX_FILE_BYTES,
    onError: (c) =>
      c.text(
        fileTooLarge(fileName(c.req.header("x-file-name")), MAX_FILE_BYTES),
        413,
      ),
  });

  const messageBodyLimit = bodyLimit({ maxSize: MAX_MESSAGE_BODY });
  const defaultBodyLimit = bodyLimit({ maxSize: 1024 * 1024 });

  app.use("*", (c: Context<E, "*", object>, next) => {
    if (
      c.req.method === "POST" &&
      uploadPaths.some((path) => path.test(c.req.path))
    ) {
      const length = c.req.header("content-length");

      return length &&
        /^\d+$/.test(length) &&
        !c.req.header("transfer-encoding")
        ? uploadLimit(c, next)
        : next();
    }

    return c.req.method === "POST" &&
      messagePaths.some((path) => path.test(c.req.path))
      ? messageBodyLimit(c, next)
      : defaultBodyLimit(c, next);
  });
};
