import {
  AgentRepository,
  type AgentPatch,
} from "../../src/bots/agent-repository";
import {
  ConversationRepository,
  type ConversationPatch,
} from "../../src/bots/conversation-repository";
import {
  ExecutionRepository,
  type NewExecution,
} from "../../src/bots/execution-repository";
import {
  GroupChatRepository,
  type GroupActivity,
  type GroupMemberChange,
} from "../../src/group-chats/group-chat-repository";
import { ScheduleRepository } from "../../src/schedules/schedule-repository";
import type { AttachmentInput } from "../../src/shared/attachments";
import type {
  Agent,
  AgentInput,
  Conversation,
  Execution,
  GroupChat,
  GroupChatInput,
  GroupMember,
  GroupTurn,
  GroupTurnStatus,
  Schedule,
  ScheduleInput,
} from "../../src/shared/domain";
import type { StoreRun } from "./store";

export const botStore = (run: StoreRun) => ({
  listAgents: (): Agent[] => {
    return run(AgentRepository.use((r) => r.list));
  },
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
    return run(AgentRepository.use((r) => r.duplicate(agentId, name)));
  },

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
  updateConversation: (conversationId: string, patch: ConversationPatch) => {
    return run(
      ConversationRepository.use((r) => r.update(conversationId, patch)),
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
  deleteConversation: (conversationId: string) => {
    return run(ConversationRepository.use((r) => r.delete(conversationId)));
  },

  listSchedules: (agentId?: string): Schedule[] => {
    return run(ScheduleRepository.use((r) => r.list(agentId)));
  },
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
        r.create(input, scheduleId, createdByAgentId),
      ),
    );
  },
  updateSchedule: (scheduleId: string, patch: Partial<ScheduleInput>) => {
    return run(ScheduleRepository.use((r) => r.update(scheduleId, patch)));
  },
  deleteSchedule: (scheduleId: string) => {
    return run(ScheduleRepository.use((r) => r.delete(scheduleId)));
  },
  updateNextRunAt: (scheduleId: string, nextRunAt: string | null) => {
    return run(
      ScheduleRepository.use((r) => r.updateNextRunAt(scheduleId, nextRunAt)),
    );
  },

  listExecutions: (agentId?: string): Execution[] => {
    return run(ExecutionRepository.use((r) => r.list(agentId)));
  },
  /** Uploads waiting for admission; cleared once Pi holds them, so they are not stored twice. */
  executionAttachments: (executionId: string): AttachmentInput[] => {
    return run(ExecutionRepository.use((r) => r.attachments(executionId)));
  },
  clearExecutionAttachments: (executionId: string) => {
    run(ExecutionRepository.use((r) => r.clearAttachments(executionId)));
  },
  getExecution: (executionId: string) => {
    return run(ExecutionRepository.use((r) => r.get(executionId)));
  },
  getExecutionByRequest: (conversationId: string, requestId: string) => {
    return run(
      ExecutionRepository.use((r) => r.getByRequest(conversationId, requestId)),
    );
  },
  findExecutionBySubmission: (agentId: string, submissionId: string) => {
    return run(
      ExecutionRepository.use((r) => r.findBySubmission(agentId, submissionId)),
    );
  },
  createExecution: (input: NewExecution, executionId?: string): Execution => {
    return run(ExecutionRepository.use((r) => r.create(input, executionId)));
  },
  updateExecution: (executionId: string, patch: Partial<Execution>) => {
    return run(ExecutionRepository.use((r) => r.update(executionId, patch)));
  },
  deleteExecution: (executionId: string) => {
    return run(ExecutionRepository.use((r) => r.delete(executionId)));
  },

  listGroupChats: (): GroupChat[] => {
    return run(GroupChatRepository.use((r) => r.list));
  },
  getGroupChat: (groupId: string) => {
    return run(GroupChatRepository.use((r) => r.get(groupId)));
  },
  createGroupChat: (input: GroupChatInput, groupId?: string): GroupChat => {
    return run(GroupChatRepository.use((r) => r.create(input, groupId)));
  },
  /** Replaces name and members; members that stay keep their place in the join order. */
  updateGroupChat: (groupId: string, input: GroupChatInput) => {
    return run(GroupChatRepository.use((r) => r.update(groupId, input)));
  },
  deleteGroupChat: (groupId: string) => {
    return run(GroupChatRepository.use((r) => r.delete(groupId)));
  },
  groupMember: (groupId: string, agentId: string): GroupMember | undefined => {
    return run(GroupChatRepository.use((r) => r.member(groupId, agentId)));
  },
  setGroupMember: (
    groupId: string,
    agentId: string,
    change: GroupMemberChange,
  ) => {
    run(GroupChatRepository.use((r) => r.setMember(groupId, agentId, change)));
  },
  groupActivity: (groupId: string): GroupActivity => {
    return run(GroupChatRepository.use((r) => r.activity(groupId)));
  },
  setGroupActivity: (groupId: string, change: Partial<GroupActivity>) => {
    run(GroupChatRepository.use((r) => r.setActivity(groupId, change)));
  },
  createGroupTurn: (turn: Omit<GroupTurn, "createdAt">): GroupTurn => {
    return run(GroupChatRepository.use((r) => r.createTurn(turn)));
  },
  getGroupTurn: (executionId: string) => {
    return run(GroupChatRepository.use((r) => r.getTurn(executionId)));
  },
  updateGroupTurn: (
    executionId: string,
    change: { status: GroupTurnStatus },
  ) => {
    run(GroupChatRepository.use((r) => r.updateTurn(executionId, change)));
  },
  /** The member's unsettled turn in the group; there is at most one. */
  activeGroupTurn: (groupId: string, agentId: string) => {
    return run(GroupChatRepository.use((r) => r.activeTurn(groupId, agentId)));
  },
  listGroupTurns: (
    filter: { groupId?: string; status?: GroupTurnStatus[] } = {},
  ): GroupTurn[] => {
    return run(GroupChatRepository.use((r) => r.listTurns(filter)));
  },
});
