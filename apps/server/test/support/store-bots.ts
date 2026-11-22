import {
  AgentRepository,
  type AgentPatch,
} from "../../src/bot-store/agent-repository";
import { duplicateAgent } from "../../src/bots/agent-duplicate";
import { ConversationRepository } from "../../src/bot-store/conversation-repository";
import {
  ExecutionRepository,
  type NewExecution,
} from "../../src/bot-store/execution-repository";
import { ScheduleRepository } from "../../src/automations/schedule-repository";
import type { Agent, AgentInput } from "../../src/contract/agents";
import type { Execution } from "../../src/shared/domain";
import type { Schedule, ScheduleInput } from "../../src/contract/schedules";
import type { Conversation } from "../../src/bot-store/conversation-repository";
import type { StoreRun } from "./store";

const agentStore = (run: StoreRun) => ({
  getAgent: (agentId: string) => {
    return run(AgentRepository.use((r) => r.get(agentId)));
  },
  createAgent: (input: AgentInput, agentId?: string): Agent => {
    return run(AgentRepository.use((r) => r.create(input, agentId)));
  },
  updateAgent: (agentId: string, patch: AgentPatch) => {
    return run(AgentRepository.use((r) => r.update(agentId, patch)));
  },
  deleteAgent: (agentId: string) => {
    return run(AgentRepository.use((r) => r.delete(agentId)));
  },
  duplicateAgent: (agentId: string, name?: string) => {
    return run(duplicateAgent(agentId, name));
  },
});

const conversationStore = (run: StoreRun) => ({
  listConversations: (
    agentId?: string,
    includeArchived = false,
  ): Conversation[] => {
    return run(
      ConversationRepository.use((r) => r.list(agentId, includeArchived)),
    );
  },
  getConversation: (conversationId: string) => {
    return run(ConversationRepository.use((r) => r.get(conversationId)));
  },
  createConversation: (
    input: { agentId: string; title: string },
    conversationId?: string,
  ): Conversation => {
    return run(
      ConversationRepository.use((r) => r.create(input, conversationId)),
    );
  },
  archiveConversation: (conversationId: string) => {
    return run(
      ConversationRepository.use((r) => r.setArchived(conversationId, true)),
    );
  },
  restoreConversation: (conversationId: string) => {
    return run(
      ConversationRepository.use((r) => r.setArchived(conversationId, false)),
    );
  },
});

const scheduleStore = (run: StoreRun) => ({
  getSchedule: (scheduleId: string) => {
    return run(ScheduleRepository.use((r) => r.get(scheduleId)));
  },
  createSchedule: (
    input: ScheduleInput,
    scheduleId?: string,
    createdByAgentId?: string | null,
  ): Schedule => {
    return run(
      ScheduleRepository.use((r) =>
        r.create(input, input.runAt, {
          ...(scheduleId && { id: scheduleId }),
          createdByAgentId: createdByAgentId ?? null,
        }),
      ),
    );
  },
  updateNextRunAt: (scheduleId: string, nextRunAt: string | null) => {
    return run(
      ScheduleRepository.use((r) => r.updateNextRunAt(scheduleId, nextRunAt)),
    );
  },
});

const executionStore = (run: StoreRun) => ({
  listExecutions: (agentId?: string): Execution[] => {
    return run(ExecutionRepository.use((r) => r.list(agentId)));
  },
  executionAttachments: (executionId: string) => {
    return run(ExecutionRepository.use((r) => r.attachments(executionId)));
  },
  getExecution: (executionId: string) => {
    return run(ExecutionRepository.use((r) => r.get(executionId)));
  },
  getExecutionByRequest: (conversationId: string, requestId: string) => {
    return run(
      ExecutionRepository.use((r) => r.getByRequest(conversationId, requestId)),
    );
  },
  createExecution: (input: NewExecution, executionId?: string): Execution => {
    return run(ExecutionRepository.use((r) => r.create(input, executionId)));
  },
  updateExecution: (executionId: string, patch: Partial<Execution>) => {
    return run(ExecutionRepository.use((r) => r.update(executionId, patch)));
  },
});

export const botStore = (run: StoreRun) => ({
  ...agentStore(run),
  ...conversationStore(run),
  ...scheduleStore(run),
  ...executionStore(run),
});
