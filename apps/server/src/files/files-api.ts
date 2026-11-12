import { Effect } from "effect";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { Runner } from "../shared/runner";
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

export function registerFileRoutes({
  register,
  run,
}: {
  register: Register;
  run: Runner<Library>;
}) {
  const upload = async (library: LibraryRef, request: Request) => {
    const name = fileName(request.headers.get("x-file-name") ?? undefined);
    const mimeType = mimeSchema.parse(request.headers.get("content-type"));

    const body =
      request.body ??
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });

    const result = await run.runPromise(
      Library.use((service) =>
        service.upload(library, { name, mimeType, body }),
      ).pipe(
        Effect.map((value) => ({ kind: "ok" as const, value })),
        Effect.catchTag("FileTooLarge", (error) =>
          Effect.succeed({ kind: "too-large" as const, limit: error.limit }),
        ),
      ),
    );

    if (result.kind === "too-large")
      throw new HTTPException(413, {
        message: fileTooLarge(name, result.limit),
      });

    return result.value;
  };

  const list = (
    library: LibraryRef,
    page: { before?: string | undefined; limit: number },
  ) => {
    const input: Parameters<Library["Service"]["list"]>[1] = {
      limit: page.limit,
    };

    if (page.before !== undefined) input.before = page.before;

    return run.runPromise(
      Library.use((service) => service.list(library, input)),
    );
  };

  const download = async (library: LibraryRef, id: string) => {
    const result = await run.runPromise(
      Library.use((service) => service.download(library, id)),
    );

    return new Response(result.body, {
      status: 200,
      headers: downloadHeaders(result.file, result.hash),
    });
  };

  const remove = (library: LibraryRef, id: string) =>
    run.runPromise(Library.use((service) => service.remove(library, id)));

  register(
    routes.uploadFile,
    async (c) =>
      c.json(
        await upload({ kind: "bot", agentId: c.req.param("id") }, c.req.raw),
        201,
      ),
    { parsesBody: true },
  );
  register(routes.listFiles, async (c) =>
    c.json(
      await list(
        { kind: "bot", agentId: c.req.param("id") },
        c.req.valid("query"),
      ),
      200,
    ),
  );
  register(routes.getFile, (c) =>
    download(
      { kind: "bot", agentId: c.req.param("id") },
      c.req.param("fileId"),
    ),
  );
  register(routes.deleteFile, async (c) => {
    await remove(
      { kind: "bot", agentId: c.req.param("id") },
      c.req.param("fileId"),
    );

    return c.body(null, 204);
  });
  register(
    routes.uploadGroupFile,
    async (c) =>
      c.json(
        await upload({ kind: "group", groupId: c.req.param("id") }, c.req.raw),
        201,
      ),
    { parsesBody: true },
  );
  register(routes.listGroupFiles, async (c) =>
    c.json(
      await list(
        { kind: "group", groupId: c.req.param("id") },
        c.req.valid("query"),
      ),
      200,
    ),
  );
  register(routes.getGroupFile, (c) =>
    download(
      { kind: "group", groupId: c.req.param("id") },
      c.req.param("fileId"),
    ),
  );
  register(routes.deleteGroupFile, async (c) => {
    await remove(
      { kind: "group", groupId: c.req.param("id") },
      c.req.param("fileId"),
    );

    return c.body(null, 204);
  });
}
