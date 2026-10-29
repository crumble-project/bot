import { Context, Effect, Layer, ManagedRuntime } from "effect";
import type { JobAnswer } from "../jobs/jobs";
import type { AttachmentInput } from "../shared/attachments";
import type { Agent, Conversation, Execution } from "../shared/domain";
import type { AppError } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { SettingsRepository } from "../shared/settings-repository";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { AgentRepository } from "./agent-repository";
import { botsContext } from "./bots-context";
import { botsService } from "./bots-service";
import { BotNotices } from "./bot-notices";
import { ConversationRepository } from "./conversation-repository";
import { ExecutionRepository } from "./execution-repository";
import { BotRuntime, type AgentRuntime, type RuntimeSnapshot } from "./runtime";
import type { BotMessageEvent } from "./transcript";

export { GROUP_TURN_PREFIX } from "./bots-context";

export const delegationRequest = (sourceAgentId: string, taskId: string) =>
  `delegate:${sourceAgentId}:${taskId}`;

/** A finished reply anywhere on the server, for clients that notify their owner. */
export type ReplyActivity = {
  type: "reply";
  executionId: string;
  agentId: string;
  agentName: string;
  entryId: string | null;
  origin: string;
  preview: string;
  createdAt: string;
  /** Set for a bot's answer in a group chat; clients open the group instead of the bot chat. */
  groupId?: string;
  /** Set for a bot's answer to a coding or desktop job's report (origin `coding` or `desktop`): the job's name. */
  jobName?: string;
  groupName?: string;
};

export type ChatPreviewActivity = {
  type: "chat-preview";
  agentId: string;
  agentName: string;
  lastMessage: string;
};

/** What a bot's review of one execution changed, for the notice in its chat. */
export type LearnedActivity = {
  type: "learned";
  agentId: string;
  agentName: string;
  executionId: string;
  changes: Array<{
    changeId: string;
    target: "skill" | "memory";
    action: "create" | "update" | "delete" | "revert";
    name: string;
  }>;
  createdAt: string;
};

export type Activity = ReplyActivity | ChatPreviewActivity | LearnedActivity;

export type ChatSnapshot = RuntimeSnapshot & {
  agentId: string;
  conversation: Conversation;
  error: string | null;
};

type PageOptions = {
  before?: string | undefined;
  limit?: number | undefined;
};

type Page<K extends keyof AgentRuntime> = AgentRuntime[K] extends (
  ...args: never[]
) => Promise<infer A>
  ? A
  : never;

/** The bots' chats: admission of each input as a durable execution, its outcome, and who hears about it. */
export class Bots extends Context.Service<
  Bots,
  {
    readonly agent: (id: string) => Effect.Effect<Agent, AppError>;
    readonly conversation: (
      id: string,
    ) => Effect.Effect<{ conversation: Conversation; agent: Agent }, AppError>;
    /** Calls `callback` when the conversation changes, until the returned function is called. */
    readonly subscribe: (
      conversationId: string,
      callback: () => void,
    ) => () => void;
    readonly onActivity: (callback: (event: Activity) => void) => () => void;
    /** Runs when an execution is done, failed, or cancelled; it may run more than once for one execution. */
    readonly onSettled: (
      callback: (execution: Execution) => void | Promise<void>,
    ) => () => void;
    /** Reads existing durable history for sidebar summaries without creating a chat. */
    readonly agentPreviews: Effect.Effect<
      { agent: Agent; lastMessage: string }[]
    >;
    /**
     * Tells activity listeners about the bot's answer to a job's report, such as a desktop job asking for the owner.
     * Job reports reach the chat without an execution, so a finished execution never announces them.
     */
    readonly announceJobAnswer: (answer: JobAnswer) => Effect.Effect<void>;
    /** Tells activity listeners about a reply that did not come from a bot chat execution, or a learned change. */
    readonly announce: (
      event: ReplyActivity | LearnedActivity,
    ) => Effect.Effect<void>;
    readonly snapshot: (
      conversationId: string,
      options?: { limit?: number | undefined },
    ) => Effect.Effect<ChatSnapshot, AppError>;
    /** The bot's one continuous chat, created on first use and stable across restarts. */
    readonly chat: (agentId: string) => Effect.Effect<Conversation, AppError>;
    readonly recordBotMessage: (
      agentId: string,
      event: BotMessageEvent,
      requestId: string,
    ) => Effect.Effect<void, AppError>;
    readonly chatSnapshot: (
      agentId: string,
      options?: { limit?: number | undefined },
    ) => Effect.Effect<ChatSnapshot, AppError>;
    readonly history: (
      agentId: string,
      options: PageOptions,
    ) => Effect.Effect<Page<"history">, AppError>;
    readonly codingJobs: (
      agentId: string,
    ) => Effect.Effect<Page<"codingJobs">, AppError>;
    readonly codingJobHistory: (
      agentId: string,
      name: string,
      options: PageOptions,
    ) => Effect.Effect<Page<"codingJobHistory">, AppError>;
    readonly desktopJobs: (
      agentId: string,
    ) => Effect.Effect<Page<"desktopJobs">, AppError>;
    readonly desktopJobHistory: (
      agentId: string,
      name: string,
      options: PageOptions,
    ) => Effect.Effect<Page<"desktopJobHistory">, AppError>;
    readonly sendChat: (
      agentId: string,
      content: string,
      requestId: string,
      replyTo?: string,
      attachments?: AttachmentInput[],
      timezone?: string,
    ) => Effect.Effect<Execution, AppError>;
    /** A message from Crumble itself that starts a turn in the bot's chat; `requestId` names its origin. */
    readonly notice: (
      agentId: string,
      content: string,
      requestId: string,
    ) => Effect.Effect<Execution, AppError>;
    readonly send: (
      conversationId: string,
      content: string,
      requestId: string,
      options?: {
        scheduleId?: string;
        replyTo?: string | undefined;
        attachments?: AttachmentInput[] | undefined;
      },
    ) => Effect.Effect<Execution, AppError>;
    readonly dispatch: (
      agentId: string,
      prompt: string,
      requestId: string,
      scheduleId: string,
    ) => Effect.Effect<Execution, AppError>;
    /** Admits the executions a previous run left pending or running again. */
    readonly recover: Effect.Effect<void>;
    readonly compact: (agentId: string) => Effect.Effect<string, AppError>;
    readonly abortChat: (agentId: string) => Effect.Effect<void, AppError>;
    readonly abort: (conversationId: string) => Effect.Effect<void, AppError>;
    readonly deleteAgent: (id: string) => Effect.Effect<void, AppError>;
  }
>()("crumble/bots/Bots") {
  static readonly layer = Layer.effect(
    Bots,
    Effect.gen(function* () {
      const context = yield* botsContext;
      const bots = botsService(context);

      // Takes notices for bots' chats, such as a saved credential's, until the bots close.
      yield* context.notices.handle((agentId, text, requestId) =>
        bots.notice(agentId, text, requestId),
      );

      return Bots.of(bots);
    }),
  );
}

/** The bots for code outside Effect, such as the HTTP handlers, with the API `CrumbleService` had. */
export type BotsAccess = {
  agent(id: string): Agent;
  conversation(id: string): { conversation: Conversation; agent: Agent };
  subscribe(conversationId: string, callback: () => void): () => void;
  onActivity(callback: (event: Activity) => void): () => void;
  onSettled(
    callback: (execution: Execution) => void | Promise<void>,
  ): () => void;
  agentPreviews(): Promise<{ agent: Agent; lastMessage: string }[]>;
  announceJobAnswer(answer: JobAnswer): void;
  announce(event: ReplyActivity | LearnedActivity): void;
  snapshot(
    conversationId: string,
    options?: { limit?: number | undefined },
  ): Promise<ChatSnapshot>;
  chat(agentId: string): Promise<Conversation>;
  recordBotMessage(
    agentId: string,
    event: BotMessageEvent,
    requestId: string,
  ): Promise<void>;
  chatSnapshot(
    agentId: string,
    options?: { limit?: number | undefined },
  ): Promise<ChatSnapshot>;
  history(agentId: string, options: PageOptions): Promise<Page<"history">>;
  codingJobs(agentId: string): Promise<Page<"codingJobs">>;
  codingJobHistory(
    agentId: string,
    name: string,
    options: PageOptions,
  ): Promise<Page<"codingJobHistory">>;
  desktopJobs(agentId: string): Promise<Page<"desktopJobs">>;
  desktopJobHistory(
    agentId: string,
    name: string,
    options: PageOptions,
  ): Promise<Page<"desktopJobHistory">>;
  sendChat(
    agentId: string,
    content: string,
    requestId: string,
    replyTo?: string,
    attachments?: AttachmentInput[],
    timezone?: string,
  ): Promise<Execution>;
  notice(
    agentId: string,
    content: string,
    requestId: string,
  ): Promise<Execution>;
  send(
    conversationId: string,
    content: string,
    requestId: string,
    options?: {
      scheduleId?: string;
      replyTo?: string | undefined;
      attachments?: AttachmentInput[] | undefined;
    },
  ): Promise<Execution>;
  dispatch(
    agentId: string,
    prompt: string,
    requestId: string,
    scheduleId: string,
  ): Promise<Execution>;
  recover(): Promise<void>;
  compact(agentId: string): Promise<string>;
  abortChat(agentId: string): Promise<void>;
  abort(conversationId: string): Promise<void>;
  deleteAgent(id: string): Promise<void>;
};

export function botsAccess(runner: Runner<Bots>): BotsAccess {
  const bots = runner.runSync(Bots.use(Effect.succeed));

  return {
    agent: (id) => runner.runSync(bots.agent(id)),
    conversation: (id) => runner.runSync(bots.conversation(id)),
    subscribe: bots.subscribe,
    onActivity: bots.onActivity,
    onSettled: bots.onSettled,
    agentPreviews: () => runner.runPromise(bots.agentPreviews),
    announceJobAnswer: (answer) =>
      runner.runSync(bots.announceJobAnswer(answer)),
    announce: (event) => runner.runSync(bots.announce(event)),
    snapshot: (conversationId, options) =>
      runner.runPromise(bots.snapshot(conversationId, options)),
    chat: (agentId) => runner.runPromise(bots.chat(agentId)),
    recordBotMessage: (agentId, event, requestId) =>
      runner.runPromise(bots.recordBotMessage(agentId, event, requestId)),
    chatSnapshot: (agentId, options) =>
      runner.runPromise(bots.chatSnapshot(agentId, options)),
    history: (agentId, options) =>
      runner.runPromise(bots.history(agentId, options)),
    codingJobs: (agentId) => runner.runPromise(bots.codingJobs(agentId)),
    codingJobHistory: (agentId, name, options) =>
      runner.runPromise(bots.codingJobHistory(agentId, name, options)),
    desktopJobs: (agentId) => runner.runPromise(bots.desktopJobs(agentId)),
    desktopJobHistory: (agentId, name, options) =>
      runner.runPromise(bots.desktopJobHistory(agentId, name, options)),
    sendChat: (agentId, content, requestId, replyTo, attachments, timezone) =>
      runner.runPromise(
        bots.sendChat(
          agentId,
          content,
          requestId,
          replyTo,
          attachments,
          timezone,
        ),
      ),
    notice: (agentId, content, requestId) =>
      runner.runPromise(bots.notice(agentId, content, requestId)),
    send: (conversationId, content, requestId, options) =>
      runner.runPromise(bots.send(conversationId, content, requestId, options)),
    dispatch: (agentId, prompt, requestId, scheduleId) =>
      runner.runPromise(bots.dispatch(agentId, prompt, requestId, scheduleId)),
    recover: () => runner.runPromise(bots.recover),
    compact: (agentId) => runner.runPromise(bots.compact(agentId)),
    abortChat: (agentId) => runner.runPromise(bots.abortChat(agentId)),
    abort: (conversationId) => runner.runPromise(bots.abort(conversationId)),
    deleteAgent: (id) => runner.runPromise(bots.deleteAgent(id)),
  };
}

/**
 * The bots over `store`'s account and `runtime`, for a test or an API without an account. Closing them closes the
 * runtime and then the store.
 */
type StandaloneServices =
  | Bots
  | BotRuntime
  | AgentRepository
  | ConversationRepository
  | ExecutionRepository
  | SettingsRepository
  | ScheduleRepository
  | BotNotices;

type StoreServices = Exclude<StandaloneServices, Bots | BotRuntime>;

export function standaloneBots<
  S extends { runtime: Runner<StoreServices>; close(): void },
>(
  store: S,
  runtime: AgentRuntime,
): BotsAccess & {
  store: S;
  /** The store's account, for code that reads its repositories. */
  core: S["runtime"];
  runtime: AgentRuntime;
  /** Runs effects over the bots and what they stand on, such as features built on the bots in a test. */
  effects: Runner<StandaloneServices>;
  close(): Promise<void>;
} {
  const bots = ManagedRuntime.make(
    Bots.layer.pipe(
      Layer.provideMerge(Layer.succeed(BotRuntime, runtime)),
      Layer.provideMerge(
        Layer.succeedContext(
          store.runtime.runSync(Effect.context<StoreServices>()),
        ),
      ),
    ),
  );

  return {
    ...botsAccess(bots),
    store,
    core: store.runtime,
    runtime,
    effects: bots,
    close: async () => {
      await bots.dispose();
      store.close();
    },
  };
}
