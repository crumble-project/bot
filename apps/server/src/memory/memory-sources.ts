import { Effect } from "effect";
import { type ChangeSource, type MemorySource } from "../shared/domain";
import type { MemoryContext } from "../bots/runtime";
import { AgentRepository } from "../bots/agent-repository";
import { ExecutionRepository } from "../bots/execution-repository";
import { GroupChatRepository } from "../group-chats/group-chat-repository";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { InvalidInput, type AppError } from "../shared/errors";

/** The newest of a run's inputs that Crumble admitted as an execution. */
const newestExecution = Effect.fnUntraced(function* (
  agentId: string,
  submissionIds: string[],
) {
  const executions = yield* ExecutionRepository;

  const found = yield* Effect.forEach(submissionIds, (id) =>
    executions.findBySubmission(agentId, id),
  );

  return found.findLast((each) => each !== null) ?? null;
});

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

  const [prefix, sourceAgentId] = execution?.requestId.split(":") ?? [];

  if (prefix === "delegate" && sourceAgentId) {
    const agent = yield* (yield* AgentRepository).get(sourceAgentId);

    return {
      kind: "bot",
      agentId: sourceAgentId,
      name: agent?.name ?? "Another bot",
    } satisfies MemorySource;
  }

  return { kind: "chat" } satisfies MemorySource;
});

/** The execution and conversation a tool call's run is answering, for the change record. */
export const changeSourceOf = Effect.fnUntraced(function* (
  agentId: string,
  context: Pick<MemoryContext, "groupId" | "submissionIds">,
) {
  const execution = yield* newestExecution(agentId, context.submissionIds);

  return {
    executionId: execution?.id ?? null,
    conversationId: execution?.conversationId ?? null,
    groupId: context.groupId,
  } satisfies ChangeSource;
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
