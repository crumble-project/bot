import { Effect } from "effect";
import { AgentRepository } from "../../src/bot-store/agent-repository";
import type { AgentPatch } from "../../src/bot-store/agent-repository";
import { duplicateAgent } from "../../src/bots/agent-duplicate";
import { ConversationRepository } from "../../src/bot-store/conversation-repository";
import { ExecutionRepository } from "../../src/bot-store/execution-repository";
import type { NewExecution } from "../../src/bot-store/execution-repository";
import { ScheduleRepository } from "../../src/automations/schedule-repository";
import type { Agent, AgentInput } from "../../src/contract/agents";
import type { Execution } from "../../src/shared/domain";
import type { Schedule, ScheduleInput } from "../../src/contract/schedules";
import type { Conversation } from "../../src/bot-store/conversation-repository";
import type { StoreRun } from "./store";

const agentStore = (run: StoreRun) => ({
  getAgent: (agentId: string) => {
    return run(Effect.flatMap(AgentRepository, (r) => r.get(agentId)));
  },
  createAgent: (input: AgentInput, agentId?: string): Agent => {
    return run(
      Effect.flatMap(AgentRepository, (r) => r.create(input, agentId)),
    );
  },
  updateAgent: (agentId: string, patch: AgentPatch) => {
    return run(
      Effect.flatMap(AgentRepository, (r) => r.update(agentId, patch)),
    );
  },
  deleteAgent: (agentId: string) => {
    return run(Effect.flatMap(AgentRepository, (r) => r.delete(agentId)));
  },
  duplicateAgent: (agentId: string, name?: string) => {
    return run(duplicateAgent(agentId, name));
  },
});

const conversationStore = (run: StoreRun) => ({
  listConversations: (
    agentId?: string,
    includeArchived = false,
  ): Array<Conversation> => {
    return run(
      Effect.flatMap(ConversationRepository, (r) =>
        r.list(agentId, includeArchived),
      ),
    );
  },
  getConversation: (conversationId: string) => {
    return run(
      Effect.flatMap(ConversationRepository, (r) => r.get(conversationId)),
    );
  },
  createConversation: (
    input: { agentId: string; title: string },
    conversationId?: string,
  ): Conversation => {
    return run(
      Effect.flatMap(ConversationRepository, (r) =>
        r.create(input, conversationId),
      ),
    );
  },
  archiveConversation: (conversationId: string) => {
    return run(
      Effect.flatMap(ConversationRepository, (r) =>
        r.setArchived(conversationId, true),
      ),
    );
  },
  restoreConversation: (conversationId: string) => {
    return run(
      Effect.flatMap(ConversationRepository, (r) =>
        r.setArchived(conversationId, false),
      ),
    );
  },
});

const scheduleStore = (run: StoreRun) => ({
  getSchedule: (scheduleId: string) => {
    return run(Effect.flatMap(ScheduleRepository, (r) => r.get(scheduleId)));
  },
  createSchedule: (
    input: ScheduleInput,
    scheduleId?: string,
    createdByAgentId?: string | null,
  ): Schedule => {
    return run(
      Effect.flatMap(ScheduleRepository, (r) =>
        r.create(input, input.runAt, {
          ...(scheduleId && { id: scheduleId }),
          createdByAgentId: createdByAgentId ?? null,
        }),
      ),
    );
  },
  updateNextRunAt: (scheduleId: string, nextRunAt: string | null) => {
    return run(
      Effect.flatMap(ScheduleRepository, (r) =>
        r.updateNextRunAt(scheduleId, nextRunAt),
      ),
    );
  },
});

const executionStore = (run: StoreRun) => ({
  listExecutions: (agentId?: string): Array<Execution> => {
    return run(Effect.flatMap(ExecutionRepository, (r) => r.list(agentId)));
  },
  executionAttachments: (executionId: string) => {
    return run(
      Effect.flatMap(ExecutionRepository, (r) => r.attachments(executionId)),
    );
  },
  getExecution: (executionId: string) => {
    return run(Effect.flatMap(ExecutionRepository, (r) => r.get(executionId)));
  },
  getExecutionByRequest: (conversationId: string, requestId: string) => {
    return run(
      Effect.flatMap(ExecutionRepository, (r) =>
        r.getByRequest(conversationId, requestId),
      ),
    );
  },
  createExecution: (input: NewExecution, executionId?: string): Execution => {
    return run(
      Effect.flatMap(ExecutionRepository, (r) => r.create(input, executionId)),
    );
  },
  updateExecution: (executionId: string, patch: Partial<Execution>) => {
    return run(
      Effect.flatMap(ExecutionRepository, (r) => r.update(executionId, patch)),
    );
  },
});

export const botStore = (run: StoreRun) => ({
  ...agentStore(run),
  ...conversationStore(run),
  ...scheduleStore(run),
  ...executionStore(run),
});
