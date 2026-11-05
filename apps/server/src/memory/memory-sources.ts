import { askingBot, parseRequestId } from "../shared/request-ids";
import { Effect } from "effect";
import type { MemorySource } from "../shared/domain";
import type { MemoryContext } from "./memory-tool";
import { AgentRepository } from "../bots/agent-repository";
import { newestExecution } from "../learning/change-source";
import { GroupChatRepository } from "../group-chats/group-chat-repository";
import { ScheduleRepository } from "../automations/schedule-repository";
import { InvalidInput, type AppError } from "../shared/errors";

/** Where the memory tool's call came from: a group turn, or the newest input its chat run is answering. */
export const memorySourceOf = Effect.fnUntraced(function* (
  agentId: string,
  context: MemoryContext,
) {
  if (context.groupId) {
    const group = yield* (yield* GroupChatRepository).get(context.groupId);

    return {
      kind: "group",
      groupId: context.groupId,
      name: group?.name ?? "Group chat",
    } satisfies MemorySource;
  }

  const execution = yield* newestExecution(agentId, context.submissionIds);

  if (execution?.scheduleId) {
    const schedule = yield* (yield* ScheduleRepository).get(
      execution.scheduleId,
    );

    return {
      kind: "task",
      scheduleId: execution.scheduleId,
      name: schedule?.name ?? "Scheduled task",
    } satisfies MemorySource;
  }

  const sourceId = execution && askingBot(parseRequestId(execution.requestId));

  if (sourceId) {
    const agent = yield* (yield* AgentRepository).get(sourceId);

    return {
      kind: "bot",
      agentId: sourceId,
      name: agent?.name ?? "Another bot",
    } satisfies MemorySource;
  }

  return { kind: "chat" } satisfies MemorySource;
});

/** A group turn writes only to the bot's own memory, so one conversation cannot change every bot's context. */
export const assertOwnMemoryInGroup = (
  context: MemoryContext,
  shared: boolean,
): Effect.Effect<void, AppError> =>
  context.groupId && shared
    ? Effect.fail(
        new InvalidInput({
          message:
            "In a group chat, save to your own memory; shared memory cannot be changed here",
        }),
      )
    : Effect.void;
