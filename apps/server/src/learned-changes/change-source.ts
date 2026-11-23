import { Effect } from "effect";
import { ExecutionRepository } from "../bot-store/execution-repository";
import type { ChangeBy, ChangeSource } from "../shared/domain";

/** What a tool call knows of its turn: its inputs and the execution its review digests. */
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

/** Who made a tool call's change: the review of an execution, or the bot in the turn that called it. */
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
