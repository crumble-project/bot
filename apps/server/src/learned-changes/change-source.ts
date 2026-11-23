import { Effect } from "effect";
import { ExecutionRepository } from "../bot-store/execution-repository";
import type { ChangeBy, ChangeSource } from "../shared/domain";

export type ChangeContext = {
  submissionIds: Array<string>;
  reviewOf: string | null;
};

export const newestExecution = Effect.fnUntraced(function* (
  agentId: string,
  submissionIds: Array<string>,
) {
  const executions = yield* ExecutionRepository;

  const found = yield* Effect.forEach(submissionIds, (id) =>
    executions.findBySubmission(agentId, id),
  );

  return found.findLast((each) => each !== null) ?? null;
});

export const changeSourceOf = Effect.fnUntraced(function* (
  agentId: string,
  context: { submissionIds: Array<string> },
) {
  const execution = yield* newestExecution(agentId, context.submissionIds);

  return {
    executionId: execution?.id ?? null,
    conversationId: execution?.conversationId ?? null,
  } satisfies ChangeSource;
});

export const changeByOf = Effect.fnUntraced(function* (
  agentId: string,
  context: ChangeContext,
) {
  if (context.reviewOf) {
    return {
      actor: "review",
      source: { executionId: context.reviewOf },
    } satisfies ChangeBy;
  }

  return {
    actor: "bot",
    source: yield* changeSourceOf(agentId, context),
  } satisfies ChangeBy;
});
