import { posix } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Context, JsonValue } from "@earendil-works/chord";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Effect } from "effect";
import type { Agent } from "../contract/agents";
import { groupOf } from "../group-chats/group-conversation";
import { toolOutput } from "../shared/tool-output";
import { WORKSPACE_PATH } from "../../workspace-image/guest";
import type { Library } from "./library";
import type { LibraryEntry, LibraryRef } from "./library-repository";

export const LIBRARY_TOOL_NAME = "library";
export const MAX_LIBRARY_OUTPUT_BYTES = 50 * 1024;
export const MAX_LIBRARY_OUTPUT_LINES = 2000;

export type LibraryArguments = {
  action: "list" | "read" | "search" | "copy";
  id?: string | undefined;
  before?: string | undefined;
  offset?: number | undefined;
  length?: number | undefined;
  query?: string | undefined;
  path?: string | undefined;
};

type Scope = {
  library: Library["Service"];
  libraries: readonly LibraryRef[];
  workspace: boolean;
};

type Environment = { env: ExecutionEnv; context: Context };

const byteSize = (value: JsonValue) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const inside = (root: string, path: string) =>
  path === root || path.startsWith(`${root}/`);

async function find(scope: Scope, id: string | undefined) {
  if (!id) throw new Error("File ID is required");

  for (const library of scope.libraries) {
    const entry = (
      await Effect.runPromise(scope.library.entries(library, [id]))
    ).get(id);

    if (entry) return entry;
  }

  throw new Error("File not found in the available libraries");
}

async function list(
  scope: Scope,
  before: string | undefined,
): Promise<JsonValue> {
  const pages = await Promise.all(
    scope.libraries.map(async (library) => ({
      library,
      files: await Effect.runPromise(
        scope.library.list(
          library,
          before ? { before, limit: 100 } : { limit: 100 },
        ),
      ),
    })),
  );

  const all = pages
    .flatMap((page) =>
      page.files.map((file) => ({ ...file, library: page.library })),
    )
    .sort((a, b) => {
      if (a.id < b.id) return 1;
      return a.id > b.id ? -1 : 0;
    });

  const files: typeof all = [];

  for (const file of all) {
    files.push(file);

    if (byteSize({ files, before: file.id }) > MAX_LIBRARY_OUTPUT_BYTES) {
      files.pop();
      break;
    }
  }

  const more =
    files.length < all.length ||
    pages.some((page) => page.files.length === 100);

  return { files, before: more ? (files.at(-1)?.id ?? null) : null };
}

function read(
  entry: LibraryEntry,
  text: string,
  args: LibraryArguments,
): JsonValue {
  const bytes = Buffer.from(text, "utf8");
  const offset = Math.min(args.offset ?? 0, bytes.length);

  const length = Math.min(
    args.length ?? MAX_LIBRARY_OUTPUT_BYTES,
    MAX_LIBRARY_OUTPUT_BYTES,
  );

  let end = Math.min(offset + length, bytes.length);
  let lines = 0;

  for (let at = offset; at < end; at++) {
    if (bytes[at] === 10 && ++lines === MAX_LIBRARY_OUTPUT_LINES) {
      end = at + 1;
      break;
    }
  }

  const result = (until: number) => ({
    id: entry.id,
    library: entry.library,
    offset,
    text: bytes.subarray(offset, until).toString("utf8"),
    nextOffset: until < bytes.length ? until : null,
    totalBytes: bytes.length,
  });

  let low = offset;
  let high = end;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (byteSize(result(middle)) <= MAX_LIBRARY_OUTPUT_BYTES) low = middle;
    else high = middle - 1;
  }

  end = low;

  while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80)
    end--;

  if (end === offset && low > offset) end = low;

  return result(end);
}

function search(
  entry: LibraryEntry,
  text: string,
  args: LibraryArguments,
): JsonValue {
  if (!args.query) throw new Error("Search query is required");
  const bytes = Buffer.from(text, "utf8");
  const query = Buffer.from(args.query, "utf8");
  const matches: { offset: number; text: string }[] = [];

  const result = (nextOffset: number | null) => ({
    id: entry.id,
    library: entry.library,
    matches,
    nextOffset,
  });

  let at = bytes.indexOf(query, args.offset ?? 0);

  while (at >= 0) {
    matches.push({
      offset: at,
      text: bytes
        .subarray(at, Math.min(at + 200, bytes.length))
        .toString("utf8")
        .replaceAll("\n", " "),
    });

    if (
      byteSize(result(bytes.length + MAX_LIBRARY_OUTPUT_BYTES)) >
        MAX_LIBRARY_OUTPUT_BYTES ||
      matches.length > MAX_LIBRARY_OUTPUT_LINES
    ) {
      matches.pop();

      return result(at);
    }

    at = bytes.indexOf(query, at + query.length);
  }

  return result(null);
}

async function safeTarget(environment: Environment, target: string) {
  const { env, context } = environment;
  const root = getOrThrow(await env.canonicalPath(WORKSPACE_PATH, context));
  let ancestor = target;

  while (true) {
    const info = await env.fileInfo(ancestor, context);

    if (info.ok && info.value.kind === "symlink")
      throw new Error(
        "Copy target must stay inside /workspace and cannot use symbolic links",
      );

    if (!info.ok && info.error.code !== "not_found") throw info.error;
    const resolved = await env.canonicalPath(ancestor, context);

    if (resolved.ok) {
      if (!inside(root, resolved.value))
        throw new Error("Copy target must stay inside /workspace");

      return;
    }

    if (resolved.error.code !== "not_found" || ancestor === WORKSPACE_PATH)
      throw resolved.error;
    ancestor = posix.dirname(ancestor);
  }
}

async function copy(
  scope: Scope,
  entry: LibraryEntry,
  args: LibraryArguments,
  environment: Environment | undefined,
): Promise<JsonValue> {
  if (!scope.workspace || !environment)
    throw new Error("Copy requires a workspace");

  const name = entry.name
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/[^\p{L}\p{N}._-]/gu, "_");

  const safeName = name && name !== "." && name !== ".." ? name : "file";

  const path = posix.resolve(
    WORKSPACE_PATH,
    args.path ?? `library/${safeName}`,
  );

  if (path === WORKSPACE_PATH || !inside(WORKSPACE_PATH, path))
    throw new Error("Copy target must stay inside /workspace");
  await safeTarget(environment, path);
  const { env, context } = environment;
  getOrThrow(
    await env.createDir(posix.dirname(path), { recursive: true }, context),
  );
  await safeTarget(environment, path);

  const downloaded = await Effect.runPromise(
    scope.library.download(entry.library, entry.id),
  );

  const reader = downloaded.body.getReader();

  try {
    getOrThrow(await env.writeFile(path, new Uint8Array(), context));

    while (true) {
      const chunk = await reader.read();

      if (chunk.done) break;
      getOrThrow(await env.appendFile(path, chunk.value, context));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }

  return { id: entry.id, library: entry.library, path, size: entry.size };
}

export async function libraryAction(
  scope: Scope,
  args: LibraryArguments,
  environment?: Environment,
): Promise<JsonValue> {
  if (
    args.offset !== undefined &&
    (!Number.isSafeInteger(args.offset) || args.offset < 0)
  )
    throw new Error("Offset must be a nonnegative byte offset");

  if (
    args.length !== undefined &&
    (!Number.isSafeInteger(args.length) || args.length <= 0)
  )
    throw new Error("Length must be positive");

  if (args.action === "list") return list(scope, args.before);
  const entry = await find(scope, args.id);

  if (args.action === "copy") return copy(scope, entry, args, environment);
  const text = await Effect.runPromise(scope.library.text(entry));

  if (text === null)
    return {
      id: entry.id,
      library: entry.library,
      note: "No text could be read from this file.",
    };

  return args.action === "read"
    ? read(entry, text, args)
    : search(entry, text, args);
}

export function libraryExtension(options: {
  agent: Agent;
  library: Library["Service"];
  libraries: (context: { groupId: string | null }) => LibraryRef[];
  workspace: boolean;
}) {
  const actions = options.workspace
    ? (["list", "read", "search", "copy"] as const)
    : (["list", "read", "search"] as const);

  const tool = defineTool({
    name: LIBRARY_TOOL_NAME,
    description:
      "List available library files, read text in bounded byte ranges, or search literal text. Results label their library. Continue list with before, and read or search with nextOffset as offset. Copy writes a file into /workspace when available.",
    parameters: Type.Object({
      action: Type.Union(actions.map((action) => Type.Literal(action))),
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      before: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      length: Type.Optional(Type.Integer({ minimum: 1 })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    }),
    replay: "unsafe",
    execute: async (args, api, context) => {
      const groupId = await groupOf(api, api.conversationId, context);
      let environment: Environment | undefined;

      if (api.env) environment = { env: api.env, context };

      return toolOutput(
        await libraryAction(
          {
            library: options.library,
            libraries: options.libraries({ groupId: groupId ?? null }),
            workspace: options.workspace,
          },
          args,
          environment,
        ),
      );
    },
  });

  return defineExtension({ name: LIBRARY_TOOL_NAME, tools: [tool] });
}
