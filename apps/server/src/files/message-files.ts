import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { attachmentKind, MAX_IMAGE_BYTES } from "../shared/attachment-rules";
import type { FileStore } from "./file-store";
import type { LibraryRef } from "./library-repository";
import type { Library } from "./library";

export const MAX_INLINE_TEXT_BYTES = 32 * 1024;

export type MessageFile =
  | { id: string; name: string; mimeType: string; size: number }
  | { id: string; deleted: true };

export type ResolvedFile =
  | {
      file: MessageFile & { deleted?: never };
      content:
        | { kind: "text"; text: string }
        | { kind: "image"; data: string }
        | { kind: "reference"; note?: string };
    }
  | { file: { id: string; deleted: true } };

export function modelBlocks(
  files: readonly ResolvedFile[],
): (TextContent | ImageContent)[] {
  return files.map((resolved) => {
    if (!("content" in resolved))
      return {
        type: "text",
        text: `File ${resolved.file.id} was deleted from the library before it arrived.`,
      };

    const { file, content } = resolved;

    if (content.kind === "image")
      return { type: "image", data: content.data, mimeType: file.mimeType };

    if (content.kind === "text")
      return {
        type: "text",
        text: `<attachment name=${JSON.stringify(file.name)}>\n${content.text}\n</attachment>`,
      };

    return {
      type: "text",
      text: `File ${JSON.stringify(file.name)} (id: ${file.id}, type: ${file.mimeType}, size: ${file.size} bytes). Use the library tool to read it.${content.note ? ` ${content.note}` : ""}`,
    };
  });
}

export const resolveMessageFiles = Effect.fnUntraced(function* (
  library: Library["Service"],
  store: FileStore["Service"],
  ref: LibraryRef,
  ids: readonly string[],
) {
  return yield* store.withLock(
    Effect.gen(function* () {
      const entries = yield* library.entries(ref, ids);

      return yield* Effect.forEach(ids, (id) =>
        Effect.gen(function* (): Effect.fn.Return<ResolvedFile> {
          const entry = entries.get(id);

          if (!entry) return { file: { id, deleted: true } };

          const file = {
            id,
            name: entry.name,
            mimeType: entry.mimeType,
            size: entry.size,
          };

          if (
            attachmentKind(entry.mimeType) === "image" &&
            entry.size <= MAX_IMAGE_BYTES
          ) {
            const stream = yield* store
              .bytes(entry.hash)
              .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)));

            if (!stream) return { file: { id, deleted: true } };

            const data = yield* Effect.promise(async () =>
              Buffer.from(await new Response(stream).arrayBuffer()).toString(
                "base64",
              ),
            );

            return { file, content: { kind: "image", data } };
          }

          if (
            attachmentKind(entry.mimeType) === "text" ||
            entry.mimeType === "application/pdf"
          ) {
            const text = yield* library.text(entry);

            if (
              text !== null &&
              Buffer.byteLength(text, "utf8") <= MAX_INLINE_TEXT_BYTES
            )
              return { file, content: { kind: "text", text } };

            if (entry.mimeType === "application/pdf" && text === null)
              return {
                file,
                content: {
                  kind: "reference",
                  note: "No text could be read from this PDF.",
                },
              };
          }

          return { file, content: { kind: "reference" } };
        }),
      );
    }).pipe(Effect.uninterruptible),
  );
});
