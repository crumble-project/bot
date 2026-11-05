import { Effect } from "effect";
import { ExecutionRepository } from "../bot-store/execution-repository";
import type { ChangeSource } from "../shared/domain";

export const newestExecution = Effect.fnUntraced(function* (
  agentId: string,
  submissionIds: string[],
) {
  const executions = yield* ExecutionRepository;

  const found = yield* Effect.forEach(submissionIds, (id) =>
    executions.findBySubmission(agentId, id),
  );

  return found.findLast((each) => each !== null) ?? null;
});

export const changeSourceOf = Effect.fnUntraced(function* (
  agentId: string,
  context: { groupId: string | null; submissionIds: string[] },
) {
  const execution = yield* newestExecution(agentId, context.submissionIds);

  return {
    executionId: execution?.id ?? null,
    conversationId: execution?.conversationId ?? null,
    groupId: context.groupId,
  } satisfies ChangeSource;
});
