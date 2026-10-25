import { asc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { OWNER } from "../shared/change-by";
import {
  memorySource,
  type ChangeBy,
  type Memory,
  type MemorySource,
} from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { LearnedChangeRepository } from "../skills/learned-change-repository";
import { memories } from "./schema";

export type NewMemory = {
  agentId: string | null;
  content: string;
  source?: MemorySource | null;
};

const memoryOf = (row: typeof memories.$inferSelect): Memory => ({
  id: row.id,
  agentId: row.agentId,
  content: row.content,
  source: row.source
    ? (memorySource.safeParse(JSON.parse(row.source)).data ?? null)
    : null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Memories: each bot's own, and the shared ones every bot with memory reads. */
export class MemoryRepository extends Context.Service<
  MemoryRepository,
  {
    /** One bot's memories, or the shared ones for `null`. */
    readonly list: (agentId: string | null) => Effect.Effect<Memory[]>;
    readonly get: (memoryId: string) => Effect.Effect<Memory | null>;
    readonly create: (
      input: NewMemory,
      memoryId?: string,
      by?: ChangeBy | null,
    ) => Effect.Effect<Memory>;
    readonly update: (
      memoryId: string,
      patch: { content?: string | undefined },
      by?: ChangeBy | null,
    ) => Effect.Effect<Memory | null>;
    readonly delete: (
      memoryId: string,
      by?: ChangeBy | null,
    ) => Effect.Effect<boolean>;
    /** Puts a memory back as it was, keeping its ID and timestamps; records nothing. */
    readonly restore: (memory: Memory) => Effect.Effect<void>;
    /** Deletes a memory without recording a change, for reverts that record their own. */
    readonly discard: (memoryId: string) => Effect.Effect<void>;
  }
>()("crumble/memory/MemoryRepository") {
  static readonly layer = Layer.effect(
    MemoryRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const changes = yield* LearnedChangeRepository;

      const list = Effect.fn("MemoryRepository.list")(function* (
        agentId: string | null,
      ) {
        const rows = yield* db
          .select()
          .from(memories)
          .where(
            agentId ? eq(memories.agentId, agentId) : isNull(memories.agentId),
          )
          .orderBy(asc(memories.createdAt));

        return rows.map(memoryOf);
      }, Effect.orDie);

      const get = Effect.fn("MemoryRepository.get")(function* (
        memoryId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(memories)
          .where(eq(memories.id, memoryId));

        return row ? memoryOf(row) : null;
      }, Effect.orDie);

      const restore = Effect.fn("MemoryRepository.restore")(function* (
        memory: Memory,
      ) {
        yield* db.insert(memories).values({
          id: memory.id,
          agentId: memory.agentId,
          content: memory.content,
          createdAt: memory.createdAt,
          updatedAt: memory.updatedAt,
          source: memory.source ? JSON.stringify(memory.source) : null,
        });
      }, Effect.orDie);

      const create = Effect.fn("MemoryRepository.create")(function* (
        input: NewMemory,
        memoryId: string = crypto.randomUUID(),
        by: ChangeBy | null = OWNER,
      ) {
        const at = yield* nowIso;

        yield* restore({
          id: memoryId,
          agentId: input.agentId,
          content: input.content,
          source: input.source ?? null,
          createdAt: at,
          updatedAt: at,
        });

        const memory = (yield* get(memoryId))!;
        yield* changes.record(
          by,
          "memory",
          memory.agentId,
          memory.id,
          null,
          memory,
        );

        return memory;
      });

      const update = Effect.fn("MemoryRepository.update")(function* (
        memoryId: string,
        patch: { content?: string | undefined },
        by: ChangeBy | null = OWNER,
      ) {
        const old = yield* get(memoryId);

        if (!old) return null;

        yield* db
          .update(memories)
          .set({
            content: patch.content ?? old.content,
            updatedAt: yield* nowIso,
          })
          .where(eq(memories.id, memoryId));

        const memory = (yield* get(memoryId))!;
        yield* changes.record(by, "memory", old.agentId, old.id, old, memory);

        return memory;
      }, Effect.orDie);

      const discard = Effect.fn("MemoryRepository.discard")(function* (
        memoryId: string,
      ) {
        yield* db.delete(memories).where(eq(memories.id, memoryId));
      }, Effect.orDie);

      const remove = Effect.fn("MemoryRepository.delete")(function* (
        memoryId: string,
        by: ChangeBy | null = OWNER,
      ) {
        const old = yield* get(memoryId);

        if (!old) return false;
        yield* discard(memoryId);
        yield* changes.record(by, "memory", old.agentId, old.id, old, null);

        return true;
      });

      return MemoryRepository.of({
        list,
        get,
        create,
        update,
        delete: remove,
        restore,
        discard,
      });
    }),
  );
}
