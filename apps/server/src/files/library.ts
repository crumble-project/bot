import { Context, Effect, Layer } from "effect";
import { AgentRepository } from "../bot-store/agent-repository";
import { GroupChatRepository } from "../group-chats/group-chat-repository";
import { attachmentKind } from "../shared/attachment-rules";
import { InvalidInput, NotFound } from "../shared/errors";
import { FileStore, type FileTooLarge } from "./file-store";
import {
  LibraryRepository,
  type LibraryEntry,
  type LibraryRef,
} from "./library-repository";
import { extractPdfText } from "./pdf-text";

export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export type LibraryFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

const publicFile = ({
  id,
  name,
  mimeType,
  size,
  createdAt,
}: LibraryEntry): LibraryFile => ({ id, name, mimeType, size, createdAt });

export const downloadHeaders = (file: LibraryFile, hash: string) => ({
  "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
  "Content-Type":
    attachmentKind(file.mimeType) === "image"
      ? file.mimeType
      : "application/octet-stream",
  "Cache-Control": "private, no-cache",
  ETag: `"${hash}"`,
});

export class Library extends Context.Service<
  Library,
  {
    upload(
      library: LibraryRef,
      input: {
        name: string;
        mimeType: string;
        body: ReadableStream<Uint8Array>;
      },
    ): Effect.Effect<
      { file: LibraryFile; existed: boolean },
      FileTooLarge | NotFound
    >;
    list(
      library: LibraryRef,
      page: { before?: string; limit: number },
    ): Effect.Effect<LibraryFile[], NotFound>;
    download(
      library: LibraryRef,
      id: string,
    ): Effect.Effect<
      { file: LibraryFile; hash: string; body: ReadableStream<Uint8Array> },
      NotFound
    >;
    remove(library: LibraryRef, id: string): Effect.Effect<void, NotFound>;
    entries(
      library: LibraryRef,
      ids: readonly string[],
    ): Effect.Effect<Map<string, LibraryEntry>>;
    text(entry: LibraryEntry): Effect.Effect<string | null>;
    validate(
      library: LibraryRef,
      ids: readonly string[],
    ): Effect.Effect<void, InvalidInput>;
    removeLibrary(
      library: LibraryRef,
      removeOwner?: Effect.Effect<unknown>,
    ): Effect.Effect<void>;
  }
>()("crumble/files/Library") {
  static layer(options: { maxFileBytes: number }) {
    return Layer.effect(
      Library,
      Effect.gen(function* () {
        const files = yield* FileStore;
        const repository = yield* LibraryRepository;
        const agents = yield* AgentRepository;
        const groups = yield* GroupChatRepository;

        const exists = Effect.fnUntraced(function* (library: LibraryRef) {
          const owner =
            library.kind === "bot"
              ? yield* agents.get(library.agentId)
              : yield* groups.get(library.groupId);

          if (!owner)
            return yield* new NotFound({ message: "Library not found" });
        });

        const upload = Effect.fn("Library.upload")(function* (
          library: LibraryRef,
          input: {
            name: string;
            mimeType: string;
            body: ReadableStream<Uint8Array>;
          },
        ) {
          return yield* files.withLock(
            Effect.gen(function* () {
              yield* exists(library);
              const stored = yield* files.put(input.body, options.maxFileBytes);
              let text: LibraryEntry["text"] = "none";

              if (input.mimeType === "application/pdf") {
                const body = yield* files.bytes(stored.hash);

                const extracted = yield* Effect.promise(async () =>
                  extractPdfText(
                    new Uint8Array(await new Response(body).arrayBuffer()),
                    { ms: 10_000, memoryMib: 256 },
                  ),
                );

                if (extracted.kind === "text") {
                  yield* files.putText(stored.hash, extracted.text, "pdf");
                  text = "extracted";
                } else if (extracted.kind === "failed") text = "failed";
              } else if (attachmentKind(input.mimeType) === "text") {
                const body = yield* files.bytes(stored.hash);

                const bytes = yield* Effect.promise(() =>
                  new Response(body).arrayBuffer(),
                );

                let decoded: string | undefined;

                try {
                  decoded = new TextDecoder("utf-8", { fatal: true }).decode(
                    bytes,
                  );
                } catch {
                  text = "failed";
                }

                if (decoded !== undefined) {
                  yield* files.putText(stored.hash, decoded);
                  text = "extracted";
                }
              }

              const result = yield* repository.add({
                library,
                name: input.name,
                mimeType: input.mimeType,
                ...stored,
                text,
              });

              return {
                file: publicFile(result.entry),
                existed: result.existed,
              };
            }),
          );
        });

        const list = Effect.fn("Library.list")(function* (
          library: LibraryRef,
          page: { before?: string; limit: number },
        ) {
          yield* exists(library);

          return (yield* repository.list(library, page)).map(publicFile);
        });

        const download = Effect.fn("Library.download")(function* (
          library: LibraryRef,
          id: string,
        ) {
          yield* exists(library);
          const entry = yield* repository.get(library, id);

          if (!entry) return yield* new NotFound({ message: "File not found" });

          return {
            file: publicFile(entry),
            hash: entry.hash,
            body: yield* files.bytes(entry.hash),
          };
        });

        const remove = Effect.fn("Library.remove")(function* (
          library: LibraryRef,
          id: string,
        ) {
          yield* files.withLock(
            Effect.gen(function* () {
              yield* exists(library);
              const entry = yield* repository.remove(library, id);

              if (!entry)
                return yield* new NotFound({ message: "File not found" });
              yield* files.removeUnreferenced(entry.hash);
            }),
          );
        });

        const entries = Effect.fn("Library.entries")(function* (
          library: LibraryRef,
          ids: readonly string[],
        ) {
          return new Map(
            (yield* repository.getMany(library, ids)).map((entry) => [
              entry.id,
              entry,
            ]),
          );
        });

        const validate = Effect.fn("Library.validate")(function* (
          library: LibraryRef,
          ids: readonly string[],
        ) {
          const found = yield* entries(library, ids);

          for (const id of ids) {
            if (found.has(id)) continue;
            const name = yield* repository.deletedName(library, id);

            return yield* new InvalidInput({
              message: name
                ? `${name} was deleted from the library`
                : "File not found in this library",
            });
          }
        });

        const removeLibrary = Effect.fn("Library.removeLibrary")(function* (
          library: LibraryRef,
          removeOwner?: Effect.Effect<unknown>,
        ) {
          yield* files.withLock(
            Effect.gen(function* () {
              const hashes = yield* repository.hashes(library);

              while (true) {
                const page = yield* repository.list(library, { limit: 100 });

                if (!page.length) break;
                yield* Effect.forEach(
                  page,
                  (entry) => repository.remove(library, entry.id),
                  { discard: true },
                );
              }

              if (removeOwner) yield* removeOwner;

              yield* Effect.forEach(
                hashes,
                (hash) => files.removeUnreferenced(hash),
                { discard: true },
              );
            }),
          );
        });

        return Library.of({
          upload,
          list,
          download,
          remove,
          entries,
          validate,
          text: (entry) =>
            entry.text === "extracted"
              ? files.text(
                  entry.hash,
                  entry.mimeType === "application/pdf" ? "pdf" : "plain",
                )
              : Effect.succeed(null),
          removeLibrary,
        });
      }),
    );
  }
}
