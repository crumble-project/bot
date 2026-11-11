import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import fs, { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Context, Data, Effect, Layer, Semaphore } from "effect";
import { NotFound } from "../shared/errors";
import { LibraryRepository } from "./library-repository";

export class FileTooLarge extends Data.TaggedError("FileTooLarge")<{
  limit: number;
}> {}

export class FileStore extends Context.Service<
  FileStore,
  {
    put(
      source: ReadableStream<Uint8Array>,
      limit: number,
    ): Effect.Effect<{ hash: string; size: number }, FileTooLarge>;
    putText(
      hash: string,
      text: string,
      format?: "plain" | "pdf",
    ): Effect.Effect<void>;
    bytes(hash: string): Effect.Effect<ReadableStream<Uint8Array>, NotFound>;
    text(hash: string, format?: "plain" | "pdf"): Effect.Effect<string | null>;
    withLock<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
    removeUnreferenced(hash: string): Effect.Effect<void>;
  }
>()("crumble/files/FileStore") {
  static layer(accountDirectory: string) {
    return Layer.effect(
      FileStore,
      Effect.gen(function* () {
        const repository = yield* LibraryRepository;
        const directory = join(accountDirectory, "files");
        const temporary = join(directory, ".tmp");
        yield* Effect.sync(() => {
          mkdirSync(temporary, { recursive: true });

          for (const name of readdirSync(temporary)) {
            rmSync(join(temporary, name), { force: true });
          }
        });
        const lock = Semaphore.makeUnsafe(1);

        const pathOf = (hash: string) => {
          if (!/^[a-f0-9]{64}$/.test(hash))
            throw new Error("Invalid file hash");

          return join(directory, hash);
        };

        const put = (source: ReadableStream<Uint8Array>, limit: number) =>
          Effect.tryPromise({
            try: async (signal) => {
              const path = join(temporary, crypto.randomUUID());
              const reader = source.getReader();

              const cancel = () => {
                void reader.cancel().catch(() => undefined);
              };

              signal.addEventListener("abort", cancel, { once: true });

              try {
                const file = await open(path, "wx");
                let size = 0;
                const digest = createHash("sha256");

                try {
                  while (true) {
                    const chunk = await reader.read();

                    if (signal.aborted) throw signal.reason;

                    if (chunk.done) break;
                    size += chunk.value.byteLength;

                    if (size > limit) throw new FileTooLarge({ limit });
                    digest.update(chunk.value);
                    let offset = 0;

                    while (offset < chunk.value.byteLength) {
                      const result = await file.write(chunk.value, offset);
                      offset += result.bytesWritten;
                    }
                  }
                } finally {
                  await file.close();
                }

                const hash = digest.digest("hex");
                await rename(path, pathOf(hash));

                return { hash, size };
              } finally {
                signal.removeEventListener("abort", cancel);
                await reader.cancel().catch(() => undefined);
                reader.releaseLock();
                await rm(path, { force: true });
              }
            },
            catch: (cause) => {
              if (cause instanceof FileTooLarge) return cause;
              throw cause;
            },
          });

        const textPathOf = (hash: string, format: "plain" | "pdf") =>
          `${pathOf(hash)}${format === "pdf" ? ".pdf" : ""}.txt`;

        const putText = (
          hash: string,
          text: string,
          format: "plain" | "pdf" = "plain",
        ) =>
          Effect.promise(async () => {
            const path = join(temporary, crypto.randomUUID());

            try {
              await Bun.write(path, text);
              await rename(path, textPathOf(hash, format));
            } finally {
              await rm(path, { force: true });
            }
          });

        const bytes = Effect.fn("FileStore.bytes")(function* (hash: string) {
          const file = Bun.file(pathOf(hash));

          if (!(yield* Effect.promise(() => file.exists())))
            return yield* new NotFound({ message: "File not found" });

          return file.stream();
        });

        const text = (hash: string, format: "plain" | "pdf" = "plain") =>
          Effect.promise(async () => {
            const file = Bun.file(textPathOf(hash, format));

            return (await file.exists()) ? file.text() : null;
          });

        const removeUnreferenced = Effect.fn("FileStore.removeUnreferenced")(
          function* (hash: string) {
            if (yield* repository.referenced(hash)) return;
            yield* Effect.promise(() =>
              Promise.all([
                fs.rm(pathOf(hash), { force: true }),
                fs.rm(textPathOf(hash, "plain"), { force: true }),
                fs.rm(textPathOf(hash, "pdf"), { force: true }),
              ]),
            );
          },
          Effect.uninterruptible,
        );

        return FileStore.of({
          put,
          putText,
          bytes,
          text,
          withLock: (effect) => lock.withPermit(effect),
          removeUnreferenced,
        });
      }),
    );
  }
}
