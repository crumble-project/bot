import type { JsonValue } from "@earendil-works/chord";
import type { Credential, CredentialInfo } from "@earendil-works/pi-ai";
import { Context, Effect, ManagedRuntime } from "effect";
import type { ControlState } from "../bot-desktop/desktop-control";
import { DesktopControlRepository } from "../bot-desktop/desktop-control-repository";
import { AgentRepository, type AgentPatch } from "../bots/agent-repository";
import {
  ConversationRepository,
  type ConversationPatch,
} from "../bots/conversation-repository";
import {
  ExecutionRepository,
  type NewExecution,
} from "../bots/execution-repository";
import {
  AgentCredentialRepository,
  type CredentialAuthority,
} from "../credentials/agent-credential-repository";
import { SecretRepository } from "../credentials/secret-repository";
import {
  GroupChatRepository,
  type GroupActivity,
  type GroupMemberChange,
} from "../group-chats/group-chat-repository";
import {
  McpServerRepository,
  type NewMCPServer,
} from "../integrations/mcp-server-repository";
import { MemoryRepository, type NewMemory } from "../memory/memory-repository";
import { ProviderCredentialRepository } from "../providers/provider-credential-repository";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { ChangeReverter } from "../skills/change-reverter";
import { LearnedChangeRepository } from "../skills/learned-change-repository";
import { ReviewRepository } from "../skills/review-repository";
import {
  SkillRepository,
  type NewSkill,
  type SkillPatch,
} from "../skills/skill-repository";
import type { AttachmentInput } from "./attachments";
import type {
  Agent,
  AgentCredential,
  AgentInput,
  ChangeBy,
  Conversation,
  CredentialGrant,
  CredentialRequest,
  CredentialUse,
  Execution,
  GroupChat,
  GroupChatInput,
  GroupMember,
  GroupTurn,
  GroupTurnStatus,
  LearnedChange,
  MCPServer,
  Memory,
  Schedule,
  ScheduleInput,
  Skill,
} from "./domain";
import { ProductDatabase } from "./product-database";
import { productLayer, type ProductServices } from "./product-layer";
import { SettingsRepository } from "./settings-repository";

/**
 * The product database for code that is not Effect yet: each method runs its repository's effect synchronously.
 * Callers move to the repositories themselves, after which this facade goes.
 */
export class Store {
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    ProductServices,
    unknown
  >;
  // Set while a `transaction` callback runs, so the facade calls inside it join that transaction.
  private transactionContext: Context.Context<ProductServices> | undefined;
  constructor(dataDir: string) {
    this.runtime = ManagedRuntime.make(productLayer(dataDir));
    // Built now, so a migration or key error fails construction.
    this.runtime.runSync(Effect.void);
  }
  private run<A>(effect: Effect.Effect<A, never, ProductServices>): A {
    return this.transactionContext
      ? Effect.runSync(Effect.provideContext(effect, this.transactionContext))
      : this.runtime.runSync(effect);
  }
  close() {
    Effect.runSync(this.runtime.disposeEffect);
  }
  /** Runs `fn` atomically; a throw rolls back every write inside, including recorded changes. */
  transaction<T>(fn: () => T): T {
    if (this.transactionContext) return fn();

    return this.run(
      ProductDatabase.use((db) =>
        db.transaction(() =>
          Effect.gen({ self: this }, function* () {
            this.transactionContext = yield* Effect.context<ProductServices>();

            try {
              return fn();
            } finally {
              this.transactionContext = undefined;
            }
          }),
        ),
      ).pipe(Effect.orDie),
    );
  }

  listAgents(): Agent[] {
    return this.run(AgentRepository.use((r) => r.list));
  }
  getAgent(agentId: string) {
    return this.run(AgentRepository.use((r) => r.get(agentId)));
  }
  createAgent(input: AgentInput, agentId?: string): Agent {
    return this.run(AgentRepository.use((r) => r.create(input, agentId)));
  }
  updateAgent(agentId: string, patch: AgentPatch) {
    return this.run(AgentRepository.use((r) => r.update(agentId, patch)));
  }
  deleteAgent(agentId: string) {
    return this.run(AgentRepository.use((r) => r.delete(agentId)));
  }
  duplicateAgent(agentId: string, name?: string) {
    return this.run(AgentRepository.use((r) => r.duplicate(agentId, name)));
  }
  /** The bot desktop's control lease; null until control first changes. */
  getDesktopControl(agentId: string): ControlState | null {
    return this.run(DesktopControlRepository.use((r) => r.get(agentId)));
  }
  setDesktopControl(agentId: string, state: ControlState) {
    this.run(DesktopControlRepository.use((r) => r.set(agentId, state)));
  }

  listConversations(agentId?: string, includeArchived = false): Conversation[] {
    return this.run(
      ConversationRepository.use((r) => r.list(agentId, includeArchived)),
    );
  }
  getConversation(conversationId: string) {
    return this.run(ConversationRepository.use((r) => r.get(conversationId)));
  }
  createConversation(
    input: { agentId: string; title: string },
    conversationId?: string,
  ): Conversation {
    return this.run(
      ConversationRepository.use((r) => r.create(input, conversationId)),
    );
  }
  updateConversation(conversationId: string, patch: ConversationPatch) {
    return this.run(
      ConversationRepository.use((r) => r.update(conversationId, patch)),
    );
  }
  archiveConversation(conversationId: string) {
    return this.run(
      ConversationRepository.use((r) => r.setArchived(conversationId, true)),
    );
  }
  restoreConversation(conversationId: string) {
    return this.run(
      ConversationRepository.use((r) => r.setArchived(conversationId, false)),
    );
  }
  deleteConversation(conversationId: string) {
    return this.run(
      ConversationRepository.use((r) => r.delete(conversationId)),
    );
  }

  /** One bot's memories, or the shared ones for `null`. */
  listMemories(agentId: string | null): Memory[] {
    return this.run(MemoryRepository.use((r) => r.list(agentId)));
  }
  getMemory(memoryId: string) {
    return this.run(MemoryRepository.use((r) => r.get(memoryId)));
  }
  createMemory(input: NewMemory, memoryId?: string, by?: ChangeBy | null) {
    return this.run(MemoryRepository.use((r) => r.create(input, memoryId, by)));
  }
  updateMemory(
    memoryId: string,
    patch: { content?: string | undefined },
    by?: ChangeBy | null,
  ) {
    return this.run(MemoryRepository.use((r) => r.update(memoryId, patch, by)));
  }
  deleteMemory(memoryId: string, by?: ChangeBy | null) {
    return this.run(MemoryRepository.use((r) => r.delete(memoryId, by)));
  }

  listSchedules(agentId?: string): Schedule[] {
    return this.run(ScheduleRepository.use((r) => r.list(agentId)));
  }
  getSchedule(scheduleId: string) {
    return this.run(ScheduleRepository.use((r) => r.get(scheduleId)));
  }
  createSchedule(
    input: ScheduleInput,
    scheduleId?: string,
    createdByAgentId?: string | null,
  ): Schedule {
    return this.run(
      ScheduleRepository.use((r) =>
        r.create(input, scheduleId, createdByAgentId),
      ),
    );
  }
  updateSchedule(scheduleId: string, patch: Partial<ScheduleInput>) {
    return this.run(ScheduleRepository.use((r) => r.update(scheduleId, patch)));
  }
  deleteSchedule(scheduleId: string) {
    return this.run(ScheduleRepository.use((r) => r.delete(scheduleId)));
  }
  updateNextRunAt(scheduleId: string, nextRunAt: string | null) {
    return this.run(
      ScheduleRepository.use((r) => r.updateNextRunAt(scheduleId, nextRunAt)),
    );
  }

  listExecutions(agentId?: string): Execution[] {
    return this.run(ExecutionRepository.use((r) => r.list(agentId)));
  }
  /** Uploads waiting for admission; cleared once Pi holds them, so they are not stored twice. */
  executionAttachments(executionId: string): AttachmentInput[] {
    return this.run(ExecutionRepository.use((r) => r.attachments(executionId)));
  }
  clearExecutionAttachments(executionId: string) {
    this.run(ExecutionRepository.use((r) => r.clearAttachments(executionId)));
  }
  getExecution(executionId: string) {
    return this.run(ExecutionRepository.use((r) => r.get(executionId)));
  }
  getExecutionByRequest(conversationId: string, requestId: string) {
    return this.run(
      ExecutionRepository.use((r) => r.getByRequest(conversationId, requestId)),
    );
  }
  findExecutionBySubmission(agentId: string, submissionId: string) {
    return this.run(
      ExecutionRepository.use((r) => r.findBySubmission(agentId, submissionId)),
    );
  }
  findExecution(conversationId: string, requestId: string) {
    return this.getExecutionByRequest(conversationId, requestId);
  }
  createExecution(input: NewExecution, executionId?: string): Execution {
    return this.run(
      ExecutionRepository.use((r) => r.create(input, executionId)),
    );
  }
  updateExecution(executionId: string, patch: Partial<Execution>) {
    return this.run(
      ExecutionRepository.use((r) => r.update(executionId, patch)),
    );
  }
  deleteExecution(executionId: string) {
    return this.run(ExecutionRepository.use((r) => r.delete(executionId)));
  }

  getSetting<T = unknown>(key: string): T | undefined {
    // SAFETY: callers read a setting as the type they stored under the same key.
    return this.run(SettingsRepository.use((r) => r.get(key))) as T | undefined;
  }
  setSetting<T extends JsonValue>(key: string, value: T) {
    this.run(SettingsRepository.use((r) => r.set(key, value)));

    return value;
  }
  deleteSetting(key: string) {
    return this.run(SettingsRepository.use((r) => r.delete(key)));
  }
  listSettings(): Record<string, JsonValue> {
    return this.run(SettingsRepository.use((r) => r.list));
  }

  setCredential(key: string, value: string) {
    this.run(SecretRepository.use((r) => r.set(key, value)));
  }
  getCredential(key: string) {
    return this.run(SecretRepository.use((r) => r.get(key)));
  }
  deleteCredential(key: string) {
    return this.run(SecretRepository.use((r) => r.delete(key)));
  }
  listCredentials() {
    return this.run(SecretRepository.use((r) => r.listKeys));
  }

  /** Metadata only: listing never decrypts a value. */
  listAgentCredentials(agentId: string): AgentCredential[] {
    return this.run(AgentCredentialRepository.use((r) => r.list(agentId)));
  }
  getAgentCredential(agentId: string, name: string) {
    return this.run(AgentCredentialRepository.use((r) => r.get(agentId, name)));
  }
  /** Creating needs a value; updating keeps the stored one when `value` is omitted. The placeholder never changes. */
  saveAgentCredential(
    agentId: string,
    name: string,
    input: { hosts: string[]; value?: string | undefined; placeholder: string },
  ) {
    return this.run(
      AgentCredentialRepository.use((r) => r.save(agentId, name, input)),
    );
  }
  deleteAgentCredential(agentId: string, name: string) {
    return this.run(
      AgentCredentialRepository.use((r) => r.delete(agentId, name)),
    );
  }
  /** Each credential's placeholder by name, for the bot's job environments. */
  agentCredentialPlaceholders(agentId: string): Record<string, string> {
    return this.run(
      AgentCredentialRepository.use((r) => r.placeholders(agentId)),
    );
  }
  /** Every credential with its placeholder and decrypted value, for the credential proxy only. */
  agentCredentialGrants(agentId: string): CredentialGrant[] {
    return this.run(AgentCredentialRepository.use((r) => r.grants(agentId)));
  }
  getCredentialAuthority(agentId: string) {
    return this.run(
      AgentCredentialRepository.use((r) => r.getAuthority(agentId)),
    );
  }
  saveCredentialAuthority(agentId: string, authority: CredentialAuthority) {
    return this.run(
      AgentCredentialRepository.use((r) => r.saveAuthority(agentId, authority)),
    );
  }
  listCredentialRequests(agentId: string): CredentialRequest[] {
    return this.run(
      AgentCredentialRepository.use((r) => r.listRequests(agentId)),
    );
  }
  getCredentialRequest(agentId: string, name: string) {
    return this.run(
      AgentCredentialRepository.use((r) => r.getRequest(agentId, name)),
    );
  }
  setCredentialRequest(
    agentId: string,
    request: { name: string; hosts: string[]; reason: string },
  ) {
    return this.run(
      AgentCredentialRepository.use((r) => r.setRequest(agentId, request)),
    );
  }
  deleteCredentialRequest(agentId: string, name: string) {
    return this.run(
      AgentCredentialRepository.use((r) => r.deleteRequest(agentId, name)),
    );
  }
  addCredentialUse(
    agentId: string,
    name: string,
    use: Omit<CredentialUse, "id">,
  ) {
    this.run(
      AgentCredentialRepository.use((r) => r.addUse(agentId, name, use)),
    );
  }
  /** Newest first; page with `before` set to the last use's ID. */
  listCredentialUses(
    agentId: string,
    name: string,
    options: { limit: number; before?: string | undefined },
  ): CredentialUse[] {
    return this.run(
      AgentCredentialRepository.use((r) => r.listUses(agentId, name, options)),
    );
  }
  pruneCredentialUses(olderThan: string) {
    this.run(AgentCredentialRepository.use((r) => r.pruneUses(olderThan)));
  }

  getProviderCredential(providerId: string): Credential | undefined {
    return this.run(ProviderCredentialRepository.use((r) => r.get(providerId)));
  }
  setProviderCredential(providerId: string, credential: Credential) {
    this.run(
      ProviderCredentialRepository.use((r) => r.set(providerId, credential)),
    );
  }
  deleteProviderCredential(providerId: string) {
    return this.run(
      ProviderCredentialRepository.use((r) => r.delete(providerId)),
    );
  }
  /** Metadata only: listing never decrypts a credential. */
  listProviderCredentials(): CredentialInfo[] {
    return this.run(ProviderCredentialRepository.use((r) => r.list));
  }
  /** Moves API keys saved before typed credentials into the provider table; MCP keys never match a provider ID. */
  migrateProviderCredentials(providerIds: readonly string[]) {
    this.run(
      ProviderCredentialRepository.use((r) => r.migrateApiKeys(providerIds)),
    );
  }

  listMCPServers(): MCPServer[] {
    return this.run(McpServerRepository.use((r) => r.list));
  }
  getMCPServer(serverId: string) {
    return this.run(McpServerRepository.use((r) => r.get(serverId)));
  }
  /** A server the bot may use: enabled, and shared or its own. */
  usableMCPServer(agentId: string, serverId: string) {
    return this.run(
      McpServerRepository.use((r) => r.usable(agentId, serverId)),
    );
  }
  createMCPServer(input: NewMCPServer, serverId?: string): MCPServer {
    return this.run(McpServerRepository.use((r) => r.create(input, serverId)));
  }
  /** Changes a server's settings; which bot it belongs to is fixed at creation. */
  updateMCPServer(
    serverId: string,
    patch: Partial<Omit<MCPServer, "id" | "agentId">>,
  ) {
    return this.run(McpServerRepository.use((r) => r.update(serverId, patch)));
  }
  deleteMCPServer(serverId: string) {
    return this.run(McpServerRepository.use((r) => r.delete(serverId)));
  }

  /** One bot's skills, or the shared ones for `null`, oldest first. */
  listSkills(agentId: string | null = null): Skill[] {
    return this.run(SkillRepository.use((r) => r.list(agentId)));
  }
  getSkill(skillId: string) {
    return this.run(SkillRepository.use((r) => r.get(skillId)));
  }
  createSkill(input: NewSkill, skillId?: string, by?: ChangeBy | null): Skill {
    return this.run(SkillRepository.use((r) => r.create(input, skillId, by)));
  }
  updateSkill(skillId: string, patch: SkillPatch, by?: ChangeBy | null) {
    return this.run(SkillRepository.use((r) => r.update(skillId, patch, by)));
  }
  /** Loading a skill counts as using it, and brings a stale skill back to active. */
  recordSkillUse(skillId: string) {
    this.run(SkillRepository.use((r) => r.recordUse(skillId)));
  }
  /** Bot-created skills across every bot, for the curator. */
  listBotCreatedSkills(): Skill[] {
    return this.run(SkillRepository.use((r) => r.listBotCreated));
  }
  deleteSkill(skillId: string, by?: ChangeBy | null) {
    return this.run(SkillRepository.use((r) => r.delete(skillId, by)));
  }

  /** Adds a turn's tool-activity rounds to the bot's review counters and returns the totals. */
  addReviewRounds(agentId: string, skillRounds: number, memoryRounds: number) {
    return this.run(
      ReviewRepository.use((r) =>
        r.addRounds(agentId, skillRounds, memoryRounds),
      ),
    );
  }
  reviewCounters(agentId: string) {
    return this.run(ReviewRepository.use((r) => r.counters(agentId)));
  }
  /** Sets one counter: zero after a review fired, or the rounds after a turn's last write to that store. */
  setReviewCounter(
    agentId: string,
    counter: "skill" | "memory",
    rounds: number,
  ) {
    this.run(
      ReviewRepository.use((r) => r.setCounter(agentId, counter, rounds)),
    );
  }
  /** Reviews in flight; a server restart drops them instead of resuming. */
  listPendingReviews() {
    return this.run(ReviewRepository.use((r) => r.listPending));
  }
  addPendingReview(
    executionId: string,
    agentId: string,
    conversationId: string,
  ) {
    this.run(
      ReviewRepository.use((r) =>
        r.addPending(executionId, agentId, conversationId),
      ),
    );
  }
  removePendingReview(executionId: string) {
    this.run(ReviewRepository.use((r) => r.removePending(executionId)));
  }

  /** Newest changes first: one bot's, the shared ones for `null`, or every change when `agentId` is undefined. */
  listChanges(
    agentId: string | null | undefined,
    options: { limit?: number | undefined; before?: string | undefined } = {},
  ): LearnedChange[] {
    return this.run(
      LearnedChangeRepository.use((r) => r.list(agentId, options)),
    );
  }
  getChange(changeId: string) {
    return this.run(LearnedChangeRepository.use((r) => r.get(changeId)));
  }
  /** The changes one execution's review made, oldest first. */
  listChangesOfExecution(executionId: string, actor: LearnedChange["actor"]) {
    return this.run(
      LearnedChangeRepository.use((r) => r.listOfExecution(executionId, actor)),
    );
  }
  /** What a review of one execution changed, kept so clients can show it after the fact. */
  addReviewResult(executionId: string, agentId: string, changeIds: string[]) {
    this.run(
      LearnedChangeRepository.use((r) =>
        r.addReviewResult(executionId, agentId, changeIds),
      ),
    );
  }
  listReviewResults(agentId: string, limit?: number) {
    return this.run(
      LearnedChangeRepository.use((r) => r.listReviewResults(agentId, limit)),
    );
  }
  /** Restores the state before `changeId`, recording the revert as a change of its own. */
  revertChange(changeId: string, by: ChangeBy): LearnedChange | null {
    return this.run(ChangeReverter.use((r) => r.revert(changeId, by)));
  }

  listGroupChats(): GroupChat[] {
    return this.run(GroupChatRepository.use((r) => r.list));
  }
  getGroupChat(groupId: string) {
    return this.run(GroupChatRepository.use((r) => r.get(groupId)));
  }
  createGroupChat(input: GroupChatInput, groupId?: string): GroupChat {
    return this.run(GroupChatRepository.use((r) => r.create(input, groupId)));
  }
  /** Replaces name and members; members that stay keep their place in the join order. */
  updateGroupChat(groupId: string, input: GroupChatInput) {
    return this.run(GroupChatRepository.use((r) => r.update(groupId, input)));
  }
  deleteGroupChat(groupId: string) {
    return this.run(GroupChatRepository.use((r) => r.delete(groupId)));
  }
  groupMember(groupId: string, agentId: string): GroupMember | undefined {
    return this.run(GroupChatRepository.use((r) => r.member(groupId, agentId)));
  }
  setGroupMember(groupId: string, agentId: string, change: GroupMemberChange) {
    this.run(
      GroupChatRepository.use((r) => r.setMember(groupId, agentId, change)),
    );
  }
  groupActivity(groupId: string): GroupActivity {
    return this.run(GroupChatRepository.use((r) => r.activity(groupId)));
  }
  setGroupActivity(groupId: string, change: Partial<GroupActivity>) {
    this.run(GroupChatRepository.use((r) => r.setActivity(groupId, change)));
  }
  createGroupTurn(turn: Omit<GroupTurn, "createdAt">): GroupTurn {
    return this.run(GroupChatRepository.use((r) => r.createTurn(turn)));
  }
  getGroupTurn(executionId: string) {
    return this.run(GroupChatRepository.use((r) => r.getTurn(executionId)));
  }
  updateGroupTurn(executionId: string, change: { status: GroupTurnStatus }) {
    this.run(GroupChatRepository.use((r) => r.updateTurn(executionId, change)));
  }
  /** The member's unsettled turn in the group; there is at most one. */
  activeGroupTurn(groupId: string, agentId: string) {
    return this.run(
      GroupChatRepository.use((r) => r.activeTurn(groupId, agentId)),
    );
  }
  listGroupTurns(
    filter: { groupId?: string; status?: GroupTurnStatus[] } = {},
  ): GroupTurn[] {
    return this.run(GroupChatRepository.use((r) => r.listTurns(filter)));
  }
}
