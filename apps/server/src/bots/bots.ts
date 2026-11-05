import { Context, Effect, Layer, ManagedRuntime } from "effect";
import type { JobAnswer } from "../jobs/jobs";
import type { JobKindName } from "../jobs/job-kinds";
import type { AttachmentInput } from "../shared/attachment-rules";
import type { Agent, Execution, LearnedChange } from "../shared/domain";
import type { Conversation } from "./conversation-repository";
import type { ReplyActivity } from "../contract/reply-event";
import type { AppError } from "../shared/errors";
import { accessOf, type Access, type Runner } from "../shared/runner";
import { SettingsRepository } from "../shared/settings-repository";
import { ScheduleRepository } from "../automations/schedule-repository";
import { ProductDatabase } from "../shared/product-database";
import { AgentRepository } from "./agent-repository";
import { botsContext } from "./bots-context";
import { botsService } from "./bots-service";
import { BotNotices } from "./bot-notices";
import { ConversationRepository } from "./conversation-repository";
import { ExecutionRepository } from "./execution-repository";
import {
  BotRuntime,
  type AgentRuntime,
  type RuntimeSnapshot,
  type RuntimeWatch,
} from "./runtime";
import type { JobAnswerInput, SendOptions } from "./bots-submissions";
import { EventRepository } from "../event-sources/event-repository";
import type { BotMessageEvent, PageOptions } from "./transcript";

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
    target: LearnedChange["target"];
    action: LearnedChange["action"];
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
    readonly jobs: (
      agentId: string,
      kind: JobKindName,
    ) => Effect.Effect<Page<"jobs">, AppError>;
    readonly jobHistory: (
      agentId: string,
      kind: JobKindName,
      name: string,
      options: PageOptions,
    ) => Effect.Effect<Page<"jobHistory">, AppError>;
    /** Sends an answer to a job's open question, which resumes the job; fails once the job no longer waits on it. */
    readonly answerJob: (
      agentId: string,
      kind: string,
      answer: JobAnswerInput,
    ) => Effect.Effect<void, AppError>;
    /** The image at `index` of an entry's attachments. */
    readonly attachment: (
      agentId: string,
      entryId: string,
      index: number,
    ) => Effect.Effect<Page<"attachment">, AppError>;
    /** Calls `callback` with the chat's snapshot now and as it changes, until the returned function is called. */
    readonly watch: (
      agentId: string,
      conversationId: string,
      callback: RuntimeWatch,
      options: { limit?: number | undefined },
    ) => Effect.Effect<() => Promise<void>, AppError>;
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
      options?: SendOptions,
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
    /** Stops everything the bot runs, as disabling or deleting it does. */
    readonly stopAgent: (agentId: string) => Effect.Effect<void, AppError>;
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

const SYNC_BOTS = [
  "agent",
  "conversation",
  "announceJobAnswer",
  "announce",
] as const;

/** The bots for code outside Effect, such as the HTTP handlers. */
export type BotsAccess = Access<Bots["Service"], (typeof SYNC_BOTS)[number]>;

export const botsAccess = (runner: Runner<Bots>): BotsAccess =>
  accessOf(runner.runSync(Bots.use(Effect.succeed)), runner, SYNC_BOTS);

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
  | EventRepository
  | BotNotices
  | ProductDatabase;

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
