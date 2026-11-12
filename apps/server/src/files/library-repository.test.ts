import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Store } from "../../test/support/store";
import { ProductDatabase } from "../shared/product-database";
import { LibraryRepository, type LibraryRef } from "./library-repository";
import { FileStore } from "./file-store";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "library-repository-"));
  const store = new Store(dir);

  const agent = store.createAgent({
    name: "Ada",
    description: "",
    instructions: "",
    provider: "faux",
    model: "chat",
    enabled: true,
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
  });

  const repository = LibraryRepository.layer.pipe(
    Layer.provide(ProductDatabase.layer(dir)),
  );

  const runtime = ManagedRuntime.make(
    FileStore.layer(dir).pipe(Layer.provideMerge(repository)),
  );

  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  cleanups.push(() => runtime.dispose());
  const library: LibraryRef = { kind: "bot", agentId: agent.id };

  const add = (hash: string) =>
    runtime.runPromise(
      LibraryRepository.use((repo) =>
        repo.add({
          library,
          hash,
          size: 5,
          name: "test.txt",
          mimeType: "text/plain",
          text: "none",
        }),
      ),
    );

  return { runtime, library, add, store, agent };
}

test("add with the same hash in one library twice returns existed: true and keeps one row", async () => {
  const { runtime, library, add } = setup();
  const first = await add("a");
  const second = await add("a");
  expect(first.existed).toBe(false);
  expect(second).toEqual({ entry: first.entry, existed: true });
  expect(
    await runtime.runPromise(
      LibraryRepository.use((repo) => repo.list(library, { limit: 10 })),
    ),
  ).toEqual([first.entry]);
});

test("removeUnreferenced preserves bytes shared between bot and group libraries", async () => {
  const { runtime, library, store, agent } = setup();

  const group = store.createGroupChat({
    name: "Shared",
    memberIds: [agent.id],
  });

  const groupLibrary: LibraryRef = { kind: "group", groupId: group.id };
  await runtime.runPromise(
    Effect.gen(function* () {
      const files = yield* FileStore;
      const repo = yield* LibraryRepository;
      yield* files.withLock(
        Effect.gen(function* () {
          const { hash, size } = yield* files.put(
            new Blob(["shared bytes"]).stream(),
            32,
          );

          yield* files.putText(hash, "extracted text");

          const input = {
            hash,
            size,
            name: "shared.txt",
            mimeType: "text/plain",
            text: "extracted" as const,
          };

          const botEntry = yield* repo.add({ ...input, library });

          const groupEntry = yield* repo.add({
            ...input,
            library: groupLibrary,
          });

          yield* repo.remove(library, botEntry.entry.id);
          yield* files.removeUnreferenced(hash);
          const body = yield* files.bytes(hash);
          expect(yield* Effect.promise(() => new Response(body).text())).toBe(
            "shared bytes",
          );
          expect(yield* files.text(hash)).toBe("extracted text");
          yield* repo.remove(groupLibrary, groupEntry.entry.id);
          yield* files.removeUnreferenced(hash);
          expect((yield* files.bytes(hash).pipe(Effect.flip))._tag).toBe(
            "NotFound",
          );
          expect(yield* files.text(hash)).toBeNull();
        }),
      );
    }),
  );
});

test("list returns newest first and pages by before", async () => {
  const { runtime, library, add } = setup();
  const first = await add("a");
  const second = await add("b");
  expect(
    await runtime.runPromise(
      LibraryRepository.use((repo) => repo.list(library, { limit: 1 })),
    ),
  ).toEqual([second.entry]);
  expect(
    await runtime.runPromise(
      LibraryRepository.use((repo) =>
        repo.list(library, { limit: 1, before: second.entry.id }),
      ),
    ),
  ).toEqual([first.entry]);
});
