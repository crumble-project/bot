import { Effect } from "effect";
import type { Env } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { LibraryRef } from "./library-repository";
import { Library, downloadHeaders } from "./library";

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((name) =>
    Array.from(name).every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );

const mimeSchema = z.string().trim().toLowerCase().min(1).max(100);

export function fileName(value: string | undefined) {
  try {
    return nameSchema.parse(decodeURIComponent(value ?? ""));
  } catch {
    throw new HTTPException(400, { message: "Invalid X-File-Name" });
  }
}

function friendlySize(bytes: number) {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0)
    return `${bytes / (1024 * 1024)} MB`;

  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KB`;

  return `${bytes} bytes`;
}

export function fileTooLarge(name: string, limit: number) {
  return `${name} is larger than ${friendlySize(limit)}`;
}

const upload = Effect.fnUntraced(function* (
  library: LibraryRef,
  request: Request,
) {
  const name = fileName(request.headers.get("x-file-name") ?? undefined);
  const mimeType = mimeSchema.parse(request.headers.get("content-type"));

  const body =
    request.body ??
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

  const service = yield* Library;

  const result = yield* service.upload(library, { name, mimeType, body }).pipe(
    Effect.map((value) => ({ kind: "ok" as const, value })),
    Effect.catchTag("FileTooLarge", (error) =>
      Effect.succeed({ kind: "too-large" as const, limit: error.limit }),
    ),
  );

  if (result.kind === "too-large")
    return yield* Effect.die(
      new HTTPException(413, {
        message: fileTooLarge(name, result.limit),
      }),
    );

  return result.value;
});

const list = Effect.fnUntraced(function* (
  library: LibraryRef,
  page: { before?: string | undefined; limit: number },
) {
  const input: Parameters<Library["Service"]["list"]>[1] = {
    limit: page.limit,
  };

  if (page.before !== undefined) input.before = page.before;
  const service = yield* Library;

  return yield* service.list(library, input);
});

const download = Effect.fnUntraced(function* (library: LibraryRef, id: string) {
  const service = yield* Library;

  const result = yield* service.download(library, id);

  return new Response(result.body, {
    status: 200,
    headers: downloadHeaders(result.file, result.hash),
  });
});

const remove = (library: LibraryRef, id: string) =>
  Library.use((service) => service.remove(library, id));

export function registerFileRoutes({
  register,
}: {
  register: Register<Env, Library>;
}) {
  register(
    routes.uploadFile,
    function* (c) {
      return c.json(
        yield* upload({ kind: "bot", agentId: c.req.param("id") }, c.req.raw),
        201,
      );
    },
    { parsesBody: true },
  );
  register(routes.listFiles, function* (c) {
    return c.json(
      yield* list(
        { kind: "bot", agentId: c.req.param("id") },
        c.req.valid("query"),
      ),
      200,
    );
  });
  register(routes.getFile, function* (c) {
    return yield* download(
      { kind: "bot", agentId: c.req.param("id") },
      c.req.param("fileId"),
    );
  });
  register(routes.deleteFile, function* (c) {
    yield* remove(
      { kind: "bot", agentId: c.req.param("id") },
      c.req.param("fileId"),
    );

    return c.body(null, 204);
  });
  register(
    routes.uploadGroupFile,
    function* (c) {
      return c.json(
        yield* upload({ kind: "group", groupId: c.req.param("id") }, c.req.raw),
        201,
      );
    },
    { parsesBody: true },
  );
  register(routes.listGroupFiles, function* (c) {
    return c.json(
      yield* list(
        { kind: "group", groupId: c.req.param("id") },
        c.req.valid("query"),
      ),
      200,
    );
  });
  register(routes.getGroupFile, function* (c) {
    return yield* download(
      { kind: "group", groupId: c.req.param("id") },
      c.req.param("fileId"),
    );
  });
  register(routes.deleteGroupFile, function* (c) {
    yield* remove(
      { kind: "group", groupId: c.req.param("id") },
      c.req.param("fileId"),
    );

    return c.body(null, 204);
  });
}
