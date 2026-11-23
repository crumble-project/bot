import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { required } from "../shared/required";
import { Context, Effect, Layer } from "effect";
import { atomic, ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { newFileId } from "./ids";
import { deletedLibraryFiles, libraryFiles } from "./schema";

export type LibraryRef = { kind: "bot"; agentId: string };

export type LibraryEntry = {
  id: string;
  library: LibraryRef;
  name: string;
  mimeType: string;
  size: number;
  hash: string;
  text: "none" | "extracted" | "failed";
  description: string | null;
  createdAt: string;
};

const owner = (library: LibraryRef) =>
  eq(libraryFiles.agentId, library.agentId);

const entryOf = (row: typeof libraryFiles.$inferSelect): LibraryEntry => ({
  id: row.id,
  library: { kind: "bot", agentId: row.agentId },
  name: row.name,
  mimeType: row.mimeType,
  size: row.size,
  hash: row.hash,
  text: row.text,
  description: row.description,
  createdAt: row.createdAt,
});

export class LibraryRepository extends Context.Service<
  LibraryRepository,
  {
    add(
      input: Omit<LibraryEntry, "id" | "createdAt" | "description">,
    ): Effect.Effect<{ entry: LibraryEntry; existed: boolean }>;
    get(
      library: LibraryRef,
      id: string,
    ): Effect.Effect<LibraryEntry | undefined>;
    getMany(
      library: LibraryRef,
      ids: ReadonlyArray<string>,
    ): Effect.Effect<Array<LibraryEntry>>;
    list(
      library: LibraryRef,
      page: { before?: string; limit: number },
    ): Effect.Effect<Array<LibraryEntry>>;
    hashes(library: LibraryRef): Effect.Effect<Array<string>>;
    describe(
      library: LibraryRef,
      id: string,
      description: string | null,
    ): Effect.Effect<LibraryEntry | undefined>;
    remove(
      library: LibraryRef,
      id: string,
    ): Effect.Effect<LibraryEntry | undefined>;
    referenced(hash: string): Effect.Effect<boolean>;
    deletedName(
      library: LibraryRef,
      id: string,
    ): Effect.Effect<string | undefined>;
  }
>()("crumble/files/LibraryRepository") {
  static readonly layer = Layer.effect(
    LibraryRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const get = Effect.fn("LibraryRepository.get")(function* (
        library: LibraryRef,
        id: string,
      ) {
        const [row] = yield* db
          .select()
          .from(libraryFiles)
          .where(and(owner(library), eq(libraryFiles.id, id)));

        return row ? entryOf(row) : undefined;
      }, Effect.orDie);

      const add = Effect.fn("LibraryRepository.add")(function* (
        input: Omit<LibraryEntry, "id" | "createdAt" | "description">,
      ) {
        const rows = yield* db
          .insert(libraryFiles)
          .values({
            id: newFileId(),
            agentId: input.library.agentId,
            name: input.name,
            mimeType: input.mimeType,
            size: input.size,
            hash: input.hash,
            text: input.text,
            createdAt: yield* nowIso,
          })
          .onConflictDoNothing()
          .returning();

        if (rows[0]) {
          return { entry: entryOf(rows[0]), existed: false };
        }

        const [existing] = yield* db
          .select()
          .from(libraryFiles)
          .where(and(owner(input.library), eq(libraryFiles.hash, input.hash)));

        return {
          entry: entryOf(
            required(existing, "The library entry was not stored"),
          ),
          existed: true,
        };
      }, Effect.orDie);

      const getMany = Effect.fn("LibraryRepository.getMany")(function* (
        library: LibraryRef,
        ids: ReadonlyArray<string>,
      ) {
        if (!ids.length) {
          return [];
        }

        return (yield* db
          .select()
          .from(libraryFiles)
          .where(and(owner(library), inArray(libraryFiles.id, [...ids])))).map(
          entryOf,
        );
      }, Effect.orDie);

      const list = Effect.fn("LibraryRepository.list")(function* (
        library: LibraryRef,
        page: { before?: string; limit: number },
      ) {
        return (yield* db
          .select()
          .from(libraryFiles)
          .where(
            and(
              owner(library),
              page.before ? lt(libraryFiles.id, page.before) : undefined,
            ),
          )
          .orderBy(desc(libraryFiles.id))
          .limit(page.limit)).map(entryOf);
      }, Effect.orDie);

      const hashes = Effect.fn("LibraryRepository.hashes")(function* (
        library: LibraryRef,
      ) {
        return (yield* db
          .select({ hash: libraryFiles.hash })
          .from(libraryFiles)
          .where(owner(library))).map((row) => row.hash);
      }, Effect.orDie);

      const remove = Effect.fn("LibraryRepository.remove")(
        function* (library: LibraryRef, id: string) {
          const [row] = yield* db
            .delete(libraryFiles)
            .where(and(owner(library), eq(libraryFiles.id, id)))
            .returning();

          if (row) {
            yield* db.insert(deletedLibraryFiles).values({
              id: row.id,
              agentId: row.agentId,
              name: row.name,
            });
          }

          return row ? entryOf(row) : undefined;
        },
        atomic(db),
        Effect.orDie,
      );

      const describe = Effect.fn("LibraryRepository.describe")(function* (
        library: LibraryRef,
        id: string,
        description: string | null,
      ) {
        const [row] = yield* db
          .update(libraryFiles)
          .set({ description })
          .where(and(owner(library), eq(libraryFiles.id, id)))
          .returning();

        return row ? entryOf(row) : undefined;
      }, Effect.orDie);

      const deletedName = Effect.fn("LibraryRepository.deletedName")(function* (
        library: LibraryRef,
        id: string,
      ) {
        const [row] = yield* db
          .select({ name: deletedLibraryFiles.name })
          .from(deletedLibraryFiles)
          .where(
            and(
              eq(deletedLibraryFiles.id, id),
              eq(deletedLibraryFiles.agentId, library.agentId),
            ),
          );

        return row?.name;
      }, Effect.orDie);

      const referenced = Effect.fn("LibraryRepository.referenced")(function* (
        hash: string,
      ) {
        return (
          (yield* db
            .select({ id: libraryFiles.id })
            .from(libraryFiles)
            .where(eq(libraryFiles.hash, hash))
            .limit(1)).length > 0
        );
      }, Effect.orDie);

      return LibraryRepository.of({
        add,
        get,
        getMany,
        list,
        hashes,
        describe,
        remove,
        referenced,
        deletedName,
      });
    }),
  );
}
