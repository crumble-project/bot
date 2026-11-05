import { Effect } from "effect";
import { ExecutionRepository } from "../bot-store/execution-repository";
import type { ChangeSource } from "../shared/domain";

/** The newest of a run's inputs that Crumble admitted as an execution. */
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

/** The execution and conversation a tool call's run is answering, for the change record. */
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
