import { Context, Effect, Layer } from "effect";
import { type ChangeBy, type Memory } from "../shared/domain";
import type { MemoryContext } from "./memory-tool";
import { AgentRepository } from "../bot-store/agent-repository";
import { ExecutionRepository } from "../bot-store/execution-repository";
import { GroupChatRepository } from "../group-chats/group-chat-repository";
import { ScheduleRepository } from "../automations/schedule-repository";
import { changeByOf } from "../learned-changes/change-source";
import { MemoryRepository } from "./memory-repository";
import { assertOwnMemoryInGroup, memorySourceOf } from "./memory-sources";
import { InvalidInput, NotFound, type AppError } from "../shared/errors";
import { MAX_MEMORY_CHARS } from "../shared/limits";

const validContent = (content: string): Effect.Effect<void, AppError> =>
  !content.trim() || content.length > MAX_MEMORY_CHARS
    ? Effect.fail(
        new InvalidInput({
          message: `Memory must contain 1–${MAX_MEMORY_CHARS} characters`,
        }),
      )
    : Effect.void;

export class BotMemory extends Context.Service<
  BotMemory,
  {
    readonly list: (
      agentId: string,
    ) => Effect.Effect<(Memory & { shared?: true })[]>;
    readonly create: (
      agentId: string,
      content: string,
      shared: boolean,
      context: MemoryContext,
    ) => Effect.Effect<Memory, AppError>;
    readonly update: (
      agentId: string,
      id: string,
      content: string,
      context: MemoryContext,
    ) => Effect.Effect<Memory, AppError>;
    readonly delete: (
      agentId: string,
      id: string,
      context: MemoryContext,
    ) => Effect.Effect<void, AppError>;
  }
>()("crumble/memory/BotMemory") {
  static readonly layer = Layer.effect(
    BotMemory,
    Effect.gen(function* () {
      const memories = yield* MemoryRepository;
      const agents = yield* AgentRepository;

      const sources = yield* Effect.context<
        | AgentRepository
        | ExecutionRepository
        | GroupChatRepository
        | ScheduleRepository
      >();

      const usesSharedMemory = (agentId: string) =>
        agents
          .get(agentId)
          .pipe(Effect.map((agent) => agent?.sharedMemory === true));

      const reachable = Effect.fnUntraced(function* (
        agentId: string,
        id: string,
      ) {
        const memory = yield* memories.get(id);

        if (
          memory?.agentId === agentId ||
          (memory?.agentId === null && (yield* usesSharedMemory(agentId)))
        )
          return memory;

        return yield* Effect.fail(
          new NotFound({ message: "Memory not found" }),
        );
      });

      const changeBy = (
        agentId: string,
        context: MemoryContext,
      ): Effect.Effect<ChangeBy> =>
        changeByOf(agentId, context).pipe(Effect.provideContext(sources));

      return BotMemory.of({
        list: Effect.fn("BotMemory.list")(function* (agentId) {
          const own = yield* memories.list(agentId);

          if (!(yield* usesSharedMemory(agentId))) return own;
          const shared = yield* memories.list(null);

          return [
            ...own,
            ...shared.map((memory) => ({ ...memory, shared: true as const })),
          ];
        }),
        create: Effect.fn("BotMemory.create")(
          function* (agentId, content, shared, context) {
            yield* validContent(content);
            yield* assertOwnMemoryInGroup(context, shared);

            const source = yield* memorySourceOf(agentId, context).pipe(
              Effect.provideContext(sources),
            );

            return yield* memories.create(
              { agentId: shared ? null : agentId, content, source },
              undefined,
              yield* changeBy(agentId, context),
            );
          },
        ),
        update: Effect.fn("BotMemory.update")(
          function* (agentId, id, content, context) {
            const memory = yield* reachable(agentId, id);
            yield* assertOwnMemoryInGroup(context, memory.agentId === null);
            yield* validContent(content);

            const updated = yield* memories.update(
              id,
              { content },
              yield* changeBy(agentId, context),
            );

            if (!updated)
              return yield* Effect.fail(
                new NotFound({ message: "Memory not found" }),
              );

            return updated;
          },
        ),
        delete: Effect.fn("BotMemory.delete")(function* (agentId, id, context) {
          const memory = yield* reachable(agentId, id);
          yield* assertOwnMemoryInGroup(context, memory.agentId === null);
          yield* memories.delete(id, yield* changeBy(agentId, context));
        }),
      });
    }),
  );
}
