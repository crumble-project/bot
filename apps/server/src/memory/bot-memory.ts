import { Context, Effect, Layer } from "effect";
import { type ChangeBy, type Memory } from "../shared/domain";
import type { MemoryContext } from "../bots/runtime";
import { AgentRepository } from "../bots/agent-repository";
import { ExecutionRepository } from "../bots/execution-repository";
import { GroupChatRepository } from "../group-chats/group-chat-repository";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { MemoryRepository } from "./memory-repository";
import {
  assertOwnMemoryInGroup,
  changeSourceOf,
  memorySourceOf,
} from "./memory-sources";
import { InvalidInput, NotFound, type AppError } from "../shared/errors";

const validContent = (content: string): Effect.Effect<void, AppError> =>
  !content.trim() || content.length > 32000
    ? Effect.fail(
        new InvalidInput({ message: "Memory must contain 1–32000 characters" }),
      )
    : Effect.void;

/** What a bot's memory tool reads and changes: its own memories, and the shared ones when it uses shared memory. */
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
        context.reviewOf
          ? Effect.succeed({
              actor: "review",
              source: { executionId: context.reviewOf },
            })
          : changeSourceOf(agentId, context).pipe(
              Effect.map((source): ChangeBy => ({ actor: "bot", source })),
              Effect.provideContext(sources),
            );

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

            if (shared && !(yield* usesSharedMemory(agentId)))
              return yield* Effect.fail(
                new InvalidInput({
                  message: "Shared memory is off for this agent",
                }),
              );

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
