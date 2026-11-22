import { Effect } from "effect";
import type { MemorySource } from "../shared/domain";
import type { MemoryContext } from "./memory-tool";
import { AgentRepository } from "../bot-store/agent-repository";
import { newestExecution } from "../learned-changes/change-source";
import { ScheduleRepository } from "../automations/schedule-repository";
import {
  turnSource,
  UNKNOWN_BOT_NAME,
  UNKNOWN_SCHEDULE_NAME,
} from "../transcript/origins";

export const memorySourceOf = Effect.fnUntraced(function* (
  agentId: string,
  context: MemoryContext,
) {
  const execution = yield* newestExecution(agentId, context.submissionIds);

  const source = execution && turnSource(execution);

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
