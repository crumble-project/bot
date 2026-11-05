import { Effect } from "effect";
import type { MemorySource } from "../shared/domain";
import type { MemoryContext } from "./memory-tool";
import { AgentRepository } from "../bot-store/agent-repository";
import { newestExecution } from "../learned-changes/change-source";
import { GroupChatRepository } from "../group-chats/group-chat-repository";
import { ScheduleRepository } from "../automations/schedule-repository";
import { InvalidInput, type AppError } from "../shared/errors";
import {
  turnSource,
  UNKNOWN_BOT_NAME,
  UNKNOWN_SCHEDULE_NAME,
} from "../transcript/origins";

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

  const source = execution && turnSource(execution);

  // A memory source has no event kind: an event automation's run counts as its automation's.
  if (source?.kind === "task" || source?.kind === "event") {
    const schedule = yield* (yield* ScheduleRepository).get(source.scheduleId);

    return {
      kind: "task",
      scheduleId: source.scheduleId,
      name: schedule?.name ?? UNKNOWN_SCHEDULE_NAME,
    } satisfies MemorySource;
  }

  if (source?.kind === "bot") {
    const agent = yield* (yield* AgentRepository).get(source.agentId);

    return {
      kind: "bot",
      agentId: source.agentId,
      name: agent?.name ?? UNKNOWN_BOT_NAME,
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
