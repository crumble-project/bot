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
export const MAX_DESCRIPTION_CHARS = 300;
export const MAX_LIST_QUERY_CHARS = 200;
export const MAX_SEARCH_TEXT_BYTES = 8 * 1024 * 1024;
const LIST_PAGE = 100;
const EXCERPT_BYTES = 200;

export type LibraryArguments = {
  action: "list" | "read" | "search" | "copy" | "describe";
  id?: string | undefined;
  description?: string | undefined;
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

function queryWords(query: string | undefined) {
  if (query === undefined) return;

  const words = query.normalize("NFC").trim().split(/\s+/u).filter(Boolean);

  if (!words.length || query.length > MAX_LIST_QUERY_CHARS)
    throw new Error(
      `Search query must have words and at most ${MAX_LIST_QUERY_CHARS} characters`,
    );

  return words.map(
    (word) => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
  );
}

function excerptAt(text: string, start: number) {
  let excerpt = "";
  let bytes = 0;

  for (const point of text.slice(start)) {
    bytes += Buffer.byteLength(point, "utf8");

    if (bytes > EXCERPT_BYTES) break;
    excerpt += point;
  }

  return excerpt.replaceAll("\n", " ");
}

type ListedFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  library: LibraryRef;
  description?: string;
  excerpt?: string;
};

const newestFirst = (a: LibraryEntry, b: LibraryEntry) => {
  if (a.id === b.id) return 0;

  return a.id < b.id ? 1 : -1;
};

async function matchFile(
  scope: Scope,
  entry: LibraryEntry,
  words: RegExp[],
): Promise<{ matched: boolean; excerpt?: string; textBytes: number }> {
  const known = `${entry.name}\n${entry.description ?? ""}`.normalize("NFC");
  const missing = words.filter((word) => !word.test(known));

  if (!missing.length || entry.text !== "extracted")
    return { matched: !missing.length, textBytes: 0 };

  const raw = await Effect.runPromise(scope.library.text(entry));
  const text = raw?.normalize("NFC") ?? "";
  const textBytes = Buffer.byteLength(text, "utf8");

  if (!missing.every((word) => word.test(text)))
    return { matched: false, textBytes };

  const start = Math.min(
    ...words.flatMap((word) => {
      const index = text.search(word);

      return index >= 0 ? [index] : [];
    }),
  );

  return { matched: true, excerpt: excerptAt(text, start), textBytes };
}

function listed(entry: LibraryEntry, excerpt: string | undefined): ListedFile {
  const file: ListedFile = {
    id: entry.id,
    name: entry.name,
    mimeType: entry.mimeType,
    size: entry.size,
    createdAt: entry.createdAt,
    library: entry.library,
  };

  if (entry.description !== null) file.description = entry.description;

  if (excerpt !== undefined) file.excerpt = excerpt;

  return file;
}

async function candidates(scope: Scope, before: string | undefined) {
  const pages = await Promise.all(
    scope.libraries.map((library) =>
      Effect.runPromise(
        scope.library.browse(
          library,
          before ? { before, limit: LIST_PAGE } : { limit: LIST_PAGE },
        ),
      ),
    ),
  );

  let cutoff: string | undefined;

  for (const page of pages) {
    if (page.length !== LIST_PAGE) continue;

    const last = page.at(-1);

    if (last && (cutoff === undefined || last.id > cutoff)) cutoff = last.id;
  }

  const entries = pages
    .flat()
    .filter((entry) => cutoff === undefined || entry.id >= cutoff)
    .sort(newestFirst);

  return { entries, exhausted: cutoff === undefined };
}

async function scan(scope: Scope, entries: LibraryEntry[], words?: RegExp[]) {
  const files: ListedFile[] = [];
  let textBytes = 0;
  let scanned: string | undefined;

  for (const entry of entries) {
    const match = words
      ? await matchFile(scope, entry, words)
      : { matched: true, textBytes: 0 };

    textBytes += match.textBytes;

    if (match.matched) {
      files.push(listed(entry, match.excerpt));

      if (
        files.length > 1 &&
        byteSize({ files, before: entry.id }) > MAX_LIBRARY_OUTPUT_BYTES
      ) {
        files.pop();

        return { files, scanned, stopped: true };
      }
    }

    scanned = entry.id;

    if (textBytes > MAX_SEARCH_TEXT_BYTES && entry !== entries.at(-1))
      return { files, scanned, stopped: true };
  }

  return { files, scanned, stopped: false };
}

async function list(
  scope: Scope,
  before: string | undefined,
  query: string | undefined,
): Promise<JsonValue> {
  const words = queryWords(query);
  const { entries, exhausted } = await candidates(scope, before);
  const page = await scan(scope, entries, words);
  const done = exhausted && !page.stopped;

  return { files: page.files, before: done ? null : (page.scanned ?? null) };
}

async function describe(
  scope: Scope,
  args: LibraryArguments,
): Promise<JsonValue> {
  if (!args.id) throw new Error("File ID is required");

  if (args.description === undefined)
    throw new Error("Description is required");

  if (args.description.length > MAX_DESCRIPTION_CHARS)
    throw new Error(
      `Description must be at most ${MAX_DESCRIPTION_CHARS} characters`,
    );

  const description = args.description.trim() || null;

  for (const library of scope.libraries) {
    const entry = await Effect.runPromise(
      scope.library.describe(library, args.id, description),
    );

    if (entry) return { id: entry.id, library: entry.library, description };
  }

  throw new Error("File not found in the available libraries");
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

  if (args.action === "list") return list(scope, args.before, args.query);

  if (args.action === "describe") return describe(scope, args);
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
    ? (["list", "read", "search", "describe", "copy"] as const)
    : (["list", "read", "search", "describe"] as const);

  const tool = defineTool({
    name: LIBRARY_TOOL_NAME,
    description:
      "Work with the owner's library files. list: newest first; with query, only files whose name, description, or text contains every word, with an excerpt for text matches. Keep calling list with before while it is set, even when a page has no files. read: a file's text in bounded byte ranges. search: literal text inside one file. Continue read or search with nextOffset as offset. describe: set a file's description (empty clears it), a sentence in the owner's words about what the file is, such as 'Lena's birth certificate, issued 1994', so it can be found later; describe a file whenever its name doesn't say what it is. Descriptions are for bots; the owner's library doesn't show them. Results label their library. Copy writes a file into /workspace when available.",
    parameters: Type.Object({
      action: Type.Union(actions.map((action) => Type.Literal(action))),
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      description: Type.Optional(
        Type.String({ maxLength: MAX_DESCRIPTION_CHARS }),
      ),
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
