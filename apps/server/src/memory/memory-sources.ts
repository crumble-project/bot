import {
  AppError,
  type ChangeSource,
  type MemorySource,
} from "../shared/domain";
import type { MemoryContext } from "../bots/runtime";
import type { Store } from "../shared/store";

/** Where the memory tool's call came from: a group turn, or the newest input its chat run is answering. */
export function memorySourceOf(
  store: Store,
  agentId: string,
  context: MemoryContext,
): MemorySource {
  if (context.groupId)
    return {
      kind: "group",
      groupId: context.groupId,
      name: store.getGroupChat(context.groupId)?.name ?? "Group chat",
    };

  const execution = context.submissionIds
    .map((id) => store.findExecutionBySubmission(agentId, id))
    .findLast((each) => each !== null);

  if (execution?.scheduleId)
    return {
      kind: "task",
      scheduleId: execution.scheduleId,
      name: store.getSchedule(execution.scheduleId)?.name ?? "Scheduled task",
    };

  const [prefix, sourceAgentId] = execution?.requestId.split(":") ?? [];

  if (prefix === "delegate" && sourceAgentId)
    return {
      kind: "bot",
      agentId: sourceAgentId,
      name: store.getAgent(sourceAgentId)?.name ?? "Another bot",
    };

  return { kind: "chat" };
}

/** The execution and conversation a tool call's run is answering, for the change record. */
export function changeSourceOf(
  store: Store,
  agentId: string,
  context: Pick<MemoryContext, "groupId" | "submissionIds">,
): ChangeSource {
  const execution = context.submissionIds
    .map((id) => store.findExecutionBySubmission(agentId, id))
    .findLast((each) => each !== null);

  return {
    executionId: execution?.id ?? null,
    conversationId: execution?.conversationId ?? null,
    groupId: context.groupId,
  };
}

/** A group turn writes only to the bot's own memory, so one conversation cannot change every bot's context. */
export function assertOwnMemoryInGroup(
  context: MemoryContext,
  shared: boolean,
) {
  if (context.groupId && shared)
    throw new AppError(
      400,
      "In a group chat, save to your own memory; shared memory cannot be changed here",
    );
}
