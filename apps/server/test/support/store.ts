import { Effect, Exit, Layer, Predicate, Scope } from "effect";
import { coreLayer, type CoreServices } from "../../src/app/core-layer";
import { runnerOf, type Runner } from "../../src/shared/runner";
import { botStore } from "./store-bots";
import { configurationStore } from "./store-configuration";
import { learningStore } from "./store-learning";

export type StoreRun = <A>(effect: Effect.Effect<A, never, CoreServices>) => A;

/** An account's product database for tests to set up and inspect: each method runs a repository effect synchronously. */
export class Store {
  /** Runs effects on the account's services, such as the standalone features a test builds. */
  readonly runtime: Runner<CoreServices>;
  // Only a store that opened its own database closes it; a shared runner belongs to the account.
  private readonly owned: Scope.Closeable | undefined;

  /** Opens the product database in `source`, or runs over the account's services. */
  constructor(source: string | Runner<CoreServices>) {
    if (Predicate.isString(source)) {
      // Built in this fiber, unlike a ManagedRuntime's forked build, so runSync outlasts a long migration's yields.
      this.owned = Scope.makeUnsafe();
      this.runtime = runnerOf(
        Effect.runSync(Layer.buildWithScope(coreLayer(source), this.owned)),
      );
    } else {
      this.owned = undefined;
      this.runtime = source;
    }
  }
  /** Runs `effect` now on the account's services. */
  run<A>(effect: Effect.Effect<A, never, CoreServices>): A {
    return this.runtime.runSync(effect);
  }
  close() {
    if (this.owned) Effect.runSync(Scope.close(this.owned, Exit.void));
  }
  private readonly bots = botStore((effect) => this.run(effect));
  private readonly learning = learningStore((effect) => this.run(effect));
  private readonly configuration = configurationStore((effect) =>
    this.run(effect),
  );

  getAgent = this.bots.getAgent;
  createAgent = this.bots.createAgent;
  updateAgent = this.bots.updateAgent;
  deleteAgent = this.bots.deleteAgent;
  duplicateAgent = this.bots.duplicateAgent;

  listConversations = this.bots.listConversations;
  getConversation = this.bots.getConversation;
  createConversation = this.bots.createConversation;
  archiveConversation = this.bots.archiveConversation;
  restoreConversation = this.bots.restoreConversation;

  getSchedule = this.bots.getSchedule;
  createSchedule = this.bots.createSchedule;
  updateNextRunAt = this.bots.updateNextRunAt;

  listExecutions = this.bots.listExecutions;
  executionAttachments = this.bots.executionAttachments;
  getExecution = this.bots.getExecution;
  getExecutionByRequest = this.bots.getExecutionByRequest;
  createExecution = this.bots.createExecution;
  updateExecution = this.bots.updateExecution;

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

  getMemory = this.learning.getMemory;
  createMemory = this.learning.createMemory;

  listSkills = this.learning.listSkills;
  getSkill = this.learning.getSkill;
  createSkill = this.learning.createSkill;
  updateSkill = this.learning.updateSkill;
  recordSkillUse = this.learning.recordSkillUse;
  deleteSkill = this.learning.deleteSkill;

  reviewCounters = this.learning.reviewCounters;
  listPendingReviews = this.learning.listPendingReviews;
  addPendingReview = this.learning.addPendingReview;

  listChanges = this.learning.listChanges;
  getChange = this.learning.getChange;
  listChangesOfExecution = this.learning.listChangesOfExecution;
  listReviewResults = this.learning.listReviewResults;
  revertChange = this.learning.revertChange;

  getSetting = this.configuration.getSetting;
  setSetting = this.configuration.setSetting;

  setCredential = this.configuration.setCredential;
  getCredential = this.configuration.getCredential;
  listCredentials = this.configuration.listCredentials;

  agentCredentialPlaceholders = this.configuration.agentCredentialPlaceholders;
  listCredentialRequests = this.configuration.listCredentialRequests;
  listCredentialUses = this.configuration.listCredentialUses;

  createMCPServer = this.configuration.createMCPServer;
  updateMCPServer = this.configuration.updateMCPServer;
  deleteMCPServer = this.configuration.deleteMCPServer;
}
