import { Context, Effect, Layer } from "effect";
import type { JobAnswer } from "../jobs/jobs";
import type { JobKindName } from "../shared/job-kinds";
import type { AttachmentInput } from "../shared/attachment-rules";
import type { Agent } from "../contract/agents";
import type { Execution } from "../shared/domain";
import type { LearnedChange } from "../contract/skills";
import type { Conversation } from "../bot-store/conversation-repository";
import type { ReplyActivity } from "../contract/reply-event";
import type { AppError } from "../shared/errors";
import { accessOf, type Access, type Runner } from "../shared/runner";
import { botsContext } from "./bots-context";
import { botsService } from "./bots-service";
import type {
  AgentRuntime,
  RuntimeSnapshot,
  RuntimeWatch,
  SnapshotOptions,
} from "./runtime";
import type { JobAnswerInput, SendOptions } from "./bots-submissions";
import type { BotMessageEvent, PageOptions } from "../transcript/transcript";

export type ChatPreviewActivity = {
  type: "chat-preview";
  agentId: string;
  agentName: string;
  lastMessage: string;
};

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

export class Bots extends Context.Service<
  Bots,
  {
    readonly agent: (id: string) => Effect.Effect<Agent, AppError>;
    readonly conversation: (
      id: string,
    ) => Effect.Effect<{ conversation: Conversation; agent: Agent }, AppError>;
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
    readonly announce: (
      event: ReplyActivity | LearnedActivity,
    ) => Effect.Effect<void>;
    readonly snapshot: (
      conversationId: string,
      options?: SnapshotOptions,
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
    readonly attachment: (
      agentId: string,
      entryId: string,
      index: number,
    ) => Effect.Effect<Page<"attachment">, AppError>;
    readonly watch: (
      agentId: string,
      conversationId: string,
      callback: RuntimeWatch,
      options: SnapshotOptions,
    ) => Effect.Effect<() => Promise<void>, AppError>;
    readonly sendChat: (
      agentId: string,
      content: string,
      requestId: string,
      replyTo?: string,
      attachments?: AttachmentInput[],
      timezone?: string,
    ) => Effect.Effect<Execution, AppError>;
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
    readonly recover: Effect.Effect<void>;
    readonly compact: (agentId: string) => Effect.Effect<string, AppError>;
    readonly abortChat: (agentId: string) => Effect.Effect<void, AppError>;
    readonly abort: (conversationId: string) => Effect.Effect<void, AppError>;
    readonly stopAgent: (agentId: string) => Effect.Effect<void, AppError>;
    readonly deleteAgent: (id: string) => Effect.Effect<void, AppError>;
  }
>()("crumble/bots/Bots") {
  static readonly layer = Layer.effect(
    Bots,
    Effect.gen(function* () {
      const context = yield* botsContext;
      const bots = botsService(context);

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

export type BotsAccess = Access<Bots["Service"], (typeof SYNC_BOTS)[number]>;

export const botsAccess = (runner: Runner<Bots>): BotsAccess =>
  accessOf(runner.runSync(Bots.use(Effect.succeed)), runner, SYNC_BOTS);
