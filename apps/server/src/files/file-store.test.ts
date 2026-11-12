import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { FileStore } from "./file-store";
import { LibraryRepository } from "./library-repository";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "file-store-"));
  let referenced = false;

  const repository = Layer.succeed(
    LibraryRepository,
    LibraryRepository.of({
      add: () => Effect.die("unused"),
      get: () => Effect.succeed(undefined),
      getMany: () => Effect.succeed([]),
      list: () => Effect.succeed([]),
      hashes: () => Effect.succeed([]),
      remove: () => Effect.succeed(undefined),
      referenced: () => Effect.sync(() => referenced),
      deletedName: () => Effect.succeed(undefined),
    }),
  );

  const runtime = ManagedRuntime.make(
    FileStore.layer(dir).pipe(Layer.provide(repository)),
  );

  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => runtime.dispose());

  return {
    dir,
    runtime,
    reference: () => {
      referenced = true;
    },
  };
}

const stream = (text: string) => new Blob([text]).stream();

test("put streams into files/<sha256> and returns the size", async () => {
  const { dir, runtime } = setup();

  const result = await runtime.runPromise(
    FileStore.use((store) => store.put(stream("hello"), 10)),
  );

  expect(result).toEqual({
    hash: createHash("sha256").update("hello").digest("hex"),
    size: 5,
  });
  expect(await Bun.file(join(dir, "files", result.hash)).text()).toBe("hello");
});

test("put over the limit fails with FileTooLarge and leaves nothing in files/ or files/.tmp/", async () => {
  const { dir, runtime } = setup();

  const error = await runtime.runPromise(
    FileStore.use((store) => store.put(stream("too big"), 2)).pipe(Effect.flip),
  );

  expect(error._tag).toBe("FileTooLarge");
  expect(readdirSync(join(dir, "files"))).toEqual([".tmp"]);
  expect(readdirSync(join(dir, "files", ".tmp"))).toEqual([]);
});

test("bytes ignores a leftover temp file and the next put replaces it", async () => {
  const { dir, runtime } = setup();
  const hash = createHash("sha256").update("hello").digest("hex");
  await Bun.write(join(dir, "files", ".tmp", hash), "partial");

  const error = await runtime.runPromise(
    FileStore.use((store) => store.bytes(hash)).pipe(Effect.flip),
  );

  expect(error._tag).toBe("NotFound");
  await runtime.runPromise(
    FileStore.use((store) => store.put(stream("hello"), 10)),
  );

  const bytes = await runtime.runPromise(
    FileStore.use((store) => store.bytes(hash)),
  );

  expect(await new Response(bytes).text()).toBe("hello");
  expect(readdirSync(join(dir, "files", ".tmp"))).toEqual([]);
});

test("interrupted uploads finish cleanup before releasing the account lock", async () => {
  const { dir, runtime } = setup();
  const reading = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const source = new ReadableStream<Uint8Array>({
    pull() {
      reading.resolve();
    },
    cancel() {
      cancelled.resolve();
      return released.promise;
    },
  });
  const upload = runtime.runFork(
    FileStore.use((store) => store.withLock(store.put(source, 10))),
  );
  await reading.promise;
  const interrupted = runtime.runPromise(Fiber.interrupt(upload));
  await cancelled.promise;
  let acquired = false;
  const next = runtime.runPromise(
    FileStore.use((store) =>
      store.withLock(
        Effect.sync(() => {
          acquired = true;
        }),
      ),
    ),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(acquired).toBe(false);
  } finally {
    released.resolve();
  }
  await interrupted;
  await next;
  expect(readdirSync(join(dir, "files", ".tmp"))).toEqual([]);
});

test("interrupted removal finishes before releasing the account lock", async () => {
  const { dir, runtime } = setup();

  const { hash } = await runtime.runPromise(
    FileStore.use((store) => store.put(stream("hello"), 10)),
  );

  const target = join(dir, "files", hash);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = fs.rm;

  const spy = spyOn(fs, "rm").mockImplementation(async (path, options) => {
    if (path === target) {
      entered.resolve();
      await release.promise;
    }

    return original(path, options);
  });

  try {
    const removal = runtime.runFork(
      FileStore.use((store) => store.withLock(store.removeUnreferenced(hash))),
    );

    await entered.promise;
    const interruption = runtime.runPromise(Fiber.interrupt(removal));
    let uploaded = false;

    const upload = runtime
      .runPromise(
        FileStore.use((store) =>
          store.withLock(store.put(stream("hello"), 10)),
        ),
      )
      .then(() => {
        uploaded = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(uploaded).toBe(false);
    release.resolve();
    await interruption;
    await upload;
    expect(await Bun.file(target).text()).toBe("hello");
  } finally {
    release.resolve();
    spy.mockRestore();
  }
});

test("removeUnreferenced keeps bytes while another library's entry has the hash", async () => {
  const { dir, runtime, reference } = setup();

  const { hash } = await runtime.runPromise(
    FileStore.use((store) => store.put(stream("hello"), 10)),
  );

  reference();
  await runtime.runPromise(
    FileStore.use((store) => store.removeUnreferenced(hash)),
  );
  expect(await Bun.file(join(dir, "files", hash)).exists()).toBe(true);
});
