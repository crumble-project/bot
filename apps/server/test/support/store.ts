import { Context, Effect, ManagedRuntime, Predicate } from "effect";
import { coreLayer, type CoreServices } from "../../src/shared/core-layer";
import { ProductDatabase } from "../../src/shared/product-database";
import type { Runner } from "../../src/shared/runner";
import { botStore } from "./store-bots";
import { configurationStore } from "./store-configuration";
import { learningStore } from "./store-learning";

export type StoreRun = <A>(effect: Effect.Effect<A, never, CoreServices>) => A;

/** An account's product database for tests to set up and inspect: each method runs a repository effect synchronously. */
export class Store {
  /** Runs effects on the account's services, such as the standalone features a test builds. */
  readonly runtime: Runner<CoreServices>;
  // Only a store that opened its own database closes it; a shared runner belongs to the account.
  private readonly owned:
    | ManagedRuntime.ManagedRuntime<CoreServices, unknown>
    | undefined;
  // Set while a `transaction` callback runs, so the facade calls inside it join that transaction.
  private transactionContext: Context.Context<CoreServices> | undefined;

  /** Opens the product database in `source`, or runs over the account's services. */
  constructor(source: string | Runner<CoreServices>) {
    if (Predicate.isString(source)) {
      this.owned = ManagedRuntime.make(coreLayer(source));
      this.runtime = this.owned;
    } else {
      this.owned = undefined;
      this.runtime = source;
    }

    // Built now, so a migration or key error fails construction.
    this.runtime.runSync(Effect.void);
  }
  /** Runs `effect` now, inside the open `transaction` if there is one. */
  run<A>(effect: Effect.Effect<A, never, CoreServices>): A {
    return this.transactionContext
      ? Effect.runSync(Effect.provideContext(effect, this.transactionContext))
      : this.runtime.runSync(effect);
  }
  close() {
    if (this.owned) Effect.runSync(this.owned.disposeEffect);
  }
  /** Runs `fn` atomically; a throw rolls back every write inside, including recorded changes. */
  transaction<T>(fn: () => T): T {
    if (this.transactionContext) return fn();

    return this.run(
      ProductDatabase.use((db) =>
        db.transaction(() =>
          Effect.gen({ self: this }, function* () {
            this.transactionContext = yield* Effect.context<CoreServices>();

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

  // Resolve run at call time so every helper joins the current transaction.
  private readonly bots = botStore((effect) => this.run(effect));
  private readonly learning = learningStore((effect) => this.run(effect));
  private readonly configuration = configurationStore((effect) =>
    this.run(effect),
  );

  listAgents = this.bots.listAgents;
  getAgent = this.bots.getAgent;
  createAgent = this.bots.createAgent;
  updateAgent = this.bots.updateAgent;
  deleteAgent = this.bots.deleteAgent;
  duplicateAgent = this.bots.duplicateAgent;

  listConversations = this.bots.listConversations;
  getConversation = this.bots.getConversation;
  createConversation = this.bots.createConversation;
  updateConversation = this.bots.updateConversation;
  archiveConversation = this.bots.archiveConversation;
  restoreConversation = this.bots.restoreConversation;
  deleteConversation = this.bots.deleteConversation;

  listSchedules = this.bots.listSchedules;
  getSchedule = this.bots.getSchedule;
  createSchedule = this.bots.createSchedule;
  updateSchedule = this.bots.updateSchedule;
  deleteSchedule = this.bots.deleteSchedule;
  updateNextRunAt = this.bots.updateNextRunAt;

  listExecutions = this.bots.listExecutions;
  executionAttachments = this.bots.executionAttachments;
  clearExecutionAttachments = this.bots.clearExecutionAttachments;
  getExecution = this.bots.getExecution;
  getExecutionByRequest = this.bots.getExecutionByRequest;
  findExecutionBySubmission = this.bots.findExecutionBySubmission;
  findExecution(conversationId: string, requestId: string) {
    return this.getExecutionByRequest(conversationId, requestId);
  }
  createExecution = this.bots.createExecution;
  updateExecution = this.bots.updateExecution;
  deleteExecution = this.bots.deleteExecution;

  listGroupChats = this.bots.listGroupChats;
  getGroupChat = this.bots.getGroupChat;
  createGroupChat = this.bots.createGroupChat;
  updateGroupChat = this.bots.updateGroupChat;
  deleteGroupChat = this.bots.deleteGroupChat;
  groupMember = this.bots.groupMember;
  setGroupMember = this.bots.setGroupMember;
  groupActivity = this.bots.groupActivity;
  setGroupActivity = this.bots.setGroupActivity;
  createGroupTurn = this.bots.createGroupTurn;
  getGroupTurn = this.bots.getGroupTurn;
  updateGroupTurn = this.bots.updateGroupTurn;
  activeGroupTurn = this.bots.activeGroupTurn;
  listGroupTurns = this.bots.listGroupTurns;

  listMemories = this.learning.listMemories;
  getMemory = this.learning.getMemory;
  createMemory = this.learning.createMemory;
  updateMemory = this.learning.updateMemory;
  deleteMemory = this.learning.deleteMemory;

  listSkills = this.learning.listSkills;
  getSkill = this.learning.getSkill;
  createSkill = this.learning.createSkill;
  updateSkill = this.learning.updateSkill;
  recordSkillUse = this.learning.recordSkillUse;
  listBotCreatedSkills = this.learning.listBotCreatedSkills;
  deleteSkill = this.learning.deleteSkill;

  addReviewRounds = this.learning.addReviewRounds;
  reviewCounters = this.learning.reviewCounters;
  setReviewCounter = this.learning.setReviewCounter;
  listPendingReviews = this.learning.listPendingReviews;
  addPendingReview = this.learning.addPendingReview;
  removePendingReview = this.learning.removePendingReview;

  listChanges = this.learning.listChanges;
  getChange = this.learning.getChange;
  listChangesOfExecution = this.learning.listChangesOfExecution;
  addReviewResult = this.learning.addReviewResult;
  listReviewResults = this.learning.listReviewResults;
  revertChange = this.learning.revertChange;

  getSetting = this.configuration.getSetting;
  setSetting = this.configuration.setSetting;
  deleteSetting = this.configuration.deleteSetting;
  listSettings = this.configuration.listSettings;

  setCredential = this.configuration.setCredential;
  getCredential = this.configuration.getCredential;
  deleteCredential = this.configuration.deleteCredential;
  listCredentials = this.configuration.listCredentials;

  listAgentCredentials = this.configuration.listAgentCredentials;
  getAgentCredential = this.configuration.getAgentCredential;
  saveAgentCredential = this.configuration.saveAgentCredential;
  deleteAgentCredential = this.configuration.deleteAgentCredential;
  agentCredentialPlaceholders = this.configuration.agentCredentialPlaceholders;
  agentCredentialGrants = this.configuration.agentCredentialGrants;
  getCredentialAuthority = this.configuration.getCredentialAuthority;
  saveCredentialAuthority = this.configuration.saveCredentialAuthority;
  listCredentialRequests = this.configuration.listCredentialRequests;
  getCredentialRequest = this.configuration.getCredentialRequest;
  setCredentialRequest = this.configuration.setCredentialRequest;
  deleteCredentialRequest = this.configuration.deleteCredentialRequest;
  addCredentialUse = this.configuration.addCredentialUse;
  listCredentialUses = this.configuration.listCredentialUses;
  pruneCredentialUses = this.configuration.pruneCredentialUses;

  getProviderCredential = this.configuration.getProviderCredential;
  setProviderCredential = this.configuration.setProviderCredential;
  deleteProviderCredential = this.configuration.deleteProviderCredential;
  listProviderCredentials = this.configuration.listProviderCredentials;
  migrateProviderCredentials = this.configuration.migrateProviderCredentials;

  listMCPServers = this.configuration.listMCPServers;
  getMCPServer = this.configuration.getMCPServer;
  usableMCPServer = this.configuration.usableMCPServer;
  createMCPServer = this.configuration.createMCPServer;
  updateMCPServer = this.configuration.updateMCPServer;
  deleteMCPServer = this.configuration.deleteMCPServer;
}
