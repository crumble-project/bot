import { QueryClient } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type { routes } from "@crumble/server/contract/api-contract";
import { onSessionReset, signedOut } from "@/lib/session";

type Routes = typeof routes;

type RouteName = keyof Routes;

type JsonSchema<T> = T extends {
  content: { "application/json": { schema: infer S extends z.ZodType } };
}
  ? S
  : never;

type RequestOf<R> = R extends { request: { body: infer B } }
  ? z.input<JsonSchema<B>>
  : never;

type ResponseOf<R> = R extends { responses: infer S }
  ? z.output<JsonSchema<S[Extract<keyof S, 200 | 201 | 202>]>>
  : never;

export type RequestBody<N extends RouteName> = RequestOf<Routes[N]>;

export type ResponseBody<N extends RouteName> = ResponseOf<Routes[N]>;

type FilledPath<P extends string> = P extends `${infer A}{${string}}${infer B}`
  ? `${A}${string}${FilledPath<B>}`
  : P;

export type RoutePath<N extends RouteName> =
  | FilledPath<Routes[N]["path"]>
  | `${FilledPath<Routes[N]["path"]>}?${string}`;

type Method<N extends RouteName> = Uppercase<Routes[N]["method"]>;

type BodyArgument<N extends RouteName> = [RequestBody<N>] extends [never]
  ? []
  : Routes[N] extends { request: { body: { required: false } } }
    ? [body?: RequestBody<N>]
    : [body: RequestBody<N>];

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, error) => !(error instanceof HttpError) && count < 2,
    },
  },
});

onSessionReset(() => {
  void queryClient.cancelQueries();
  queryClient.clear();
});

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function errorMessage(response: Response) {
  const text = await response.text();

  try {
    const body: { error?: string } = JSON.parse(text);

    return body.error ?? text;
  } catch {
    return text || response.statusText;
  }
}

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);

  if (init.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");

  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers,
  });

  if (response.status === 401) signedOut();

  if (!response.ok)
    throw new HttpError(response.status, await errorMessage(response));

  return response;
}

export async function api<N extends RouteName>(
  path: RoutePath<N>,
  init?: RequestInit,
): Promise<ResponseBody<N>> {
  return (await request(path, init)).json();
}

function withBody<Body>(method: string, body: Body): RequestInit {
  return {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  };
}

export async function call<N extends RouteName>(
  path: RoutePath<N>,
  method: Method<N>,
  ...[body]: BodyArgument<N>
): Promise<ResponseBody<N>> {
  return (await request(path, withBody(method, body))).json();
}

export async function send<N extends RouteName>(
  path: RoutePath<N>,
  method: Method<N>,
  ...[body]: BodyArgument<N>
) {
  await request(path, withBody(method, body));
}

export async function apiRaw(path: string, init?: RequestInit) {
  return request(path, init);
}

export async function apiBlob(path: string, signal?: AbortSignal) {
  const response = await request(path, { signal: signal ?? null });

  return response.blob();
}

type StreamHandlers = {
  onEvent: (event: string, data: string) => void;
  /** After every (re)connection, since streams have no replay. */
  onOpen?: () => void;
  onStatus?: (status: "connected" | "reconnecting") => void;
  onGone?: () => void;
};

function dispatchStreamFrame(frame: string, handlers: StreamHandlers) {
  const lines = frame.split("\n");

  const event =
    lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim() ?? "message";

  if (event === "heartbeat") return;

  const data = lines
    .flatMap((line) =>
      line.startsWith("data:") ? [line.slice(5).replace(/^ /, "")] : [],
    )
    .join("\n");

  handlers.onEvent(event, data);
}

// A read that fails is a dropped connection, like one that ends; handlers run outside this catch.
async function nextChunk(reader: ReadableStreamDefaultReader<string>) {
  try {
    const { value, done } = await reader.read();

    return done ? null : value;
  } catch {
    return null;
  }
}

async function readEventStream(response: Response, handlers: StreamHandlers) {
  const reader = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();

  let buffer = "";

  for (;;) {
    const chunk = await nextChunk(reader);

    if (chunk === null) break;
    buffer += chunk;
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) dispatchStreamFrame(frame, handlers);
  }
}

function endsStream(error: HttpError, handlers: StreamHandlers) {
  if (error.status === 404) handlers.onGone?.();

  return error.status === 401 || error.status === 404;
}

async function connect(
  path: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
) {
  try {
    return await request(path, { signal });
  } catch (error) {
    if (signal.aborted) return "ended";

    return error instanceof HttpError && endsStream(error, handlers)
      ? "ended"
      : null;
  }
}

export async function follow(
  path: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
) {
  let delay = 500;

  while (!signal.aborted) {
    const response = await connect(path, handlers, signal);

    if (response === "ended") return;

    if (response) {
      handlers.onStatus?.("connected");
      handlers.onOpen?.();
      delay = 500;

      await readEventStream(response, handlers);

      if (signal.aborted) return;
    }

    handlers.onStatus?.("reconnecting");
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 8000);
  }
}
