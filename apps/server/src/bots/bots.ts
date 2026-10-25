import {
  Cause,
  Context,
  Effect,
  FiberMap,
  Layer,
  ManagedRuntime,
  Predicate,
  Result,
  Semaphore,
} from "effect";
import type { JobAnswer } from "../jobs/jobs";
import {
  conversationReference,
  type Agent,
  type Conversation,
  type Execution,
} from "../shared/domain";
import { appErrors } from "../shared/app-errors";
import {
  attachmentDigest,
  prepareAttachments,
  type AttachmentInput,
} from "../shared/attachments";
import type { Runner } from "../shared/runner";
import { SettingsRepository } from "../shared/settings-repository";
import type { Store } from "../shared/store";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { AgentRepository } from "./agent-repository";
import { BotNotices } from "./bot-notices";
import { ConversationRepository } from "./conversation-repository";
import { ExecutionRepository } from "./execution-repository";
import {
  BotRuntime,
  OWNER_TIMEZONE,
  type AgentRuntime,
  type RuntimeSnapshot,
} from "./runtime";
import {
  latestMessagePreview,
  latestReply,
  type BotMessageEvent,
  type MessageOrigin,
} from "./transcript";
import { NotFound, Conflict, type AppError } from "../shared/errors";

export const delegationRequest = (sourceAgentId: string, taskId: string) =>
  `delegate:${sourceAgentId}:${taskId}`;

/** Group turns run as executions too, but their output belongs to the group, not the bot chat. */
export const GROUP_TURN_PREFIX = "group-turn:";

const isGroupTurn = (execution: Execution) =>
  execution.requestId.startsWith(GROUP_TURN_PREFIX);

const isTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();

    return true;
  } catch {
    return false;
  }
};

const active = (execution: Execution) =>
  execution.status === "pending" || execution.status === "running";

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
      const agents = yield* AgentRepository;
      const conversations = yield* ConversationRepository;
      const executions = yield* ExecutionRepository;
      const settings = yield* SettingsRepository;
      const schedules = yield* ScheduleRepository;
      const runtime = yield* BotRuntime;
      const notices = yield* BotNotices;
      const scope = yield* Effect.scope;

      const listeners = new Map<string, Set<() => void>>();
      const activityListeners = new Set<(event: Activity) => void>();

      const settledListeners = new Set<
        (execution: Execution) => void | Promise<void>
      >();

      // Openings of one bot's chat run one at a time, so a second caller finds the chat the first created.
      const chatOpenings = new Map<string, Semaphore.Semaphore>();

      // Released last: the monitors stop before the runtime they wait on closes.
      yield* Effect.addFinalizer(() => Effect.promise(() => runtime.close()));
      const monitors = yield* FiberMap.make<string>();

      /** A Pi Durable call: AppErrors it throws are failures, anything else is a defect. */
      const pi = <A>(run: () => Promise<A>) =>
        appErrors(Effect.tryPromise({ try: run, catch: (error) => error }));

      const background = (label: string, subject: string) =>
        Effect.catchCause((cause: Cause.Cause<unknown>) =>
          Effect.logError(label, subject, Cause.squash(cause)),
        );

      const agent = Effect.fn("Bots.agent")(function* (id: string) {
        const found = yield* agents.get(id);

        if (!found)
          return yield* Effect.fail(
            new NotFound({ message: "Agent not found" }),
          );

        return found;
      });

      const conversation = Effect.fn("Bots.conversation")(function* (
        id: string,
      ) {
        const found = yield* conversations.get(id);

        if (!found || found.archived)
          return yield* Effect.fail(
            new NotFound({ message: "Conversation not found" }),
          );

        return { conversation: found, agent: yield* agent(found.agentId) };
      });

      const subscribe = (conversationId: string, callback: () => void) => {
        const set = listeners.get(conversationId) ?? new Set();
        set.add(callback);
        listeners.set(conversationId, set);

        return () => {
          set.delete(callback);

          if (!set.size) listeners.delete(conversationId);
        };
      };

      const onActivity = (callback: (event: Activity) => void) => {
        activityListeners.add(callback);

        return () => {
          activityListeners.delete(callback);
        };
      };

      const onSettled = (
        callback: (execution: Execution) => void | Promise<void>,
      ) => {
        settledListeners.add(callback);

        return () => {
          settledListeners.delete(callback);
        };
      };

      const changed = (conversationId: string) =>
        Effect.sync(() => {
          for (const listener of listeners.get(conversationId) ?? [])
            listener();
        });

      const emit = (event: Activity) =>
        Effect.sync(() => {
          for (const listener of activityListeners) listener(event);
        });

      const settled = Effect.fnUntraced(function* (executionId: string) {
        const execution = yield* executions.get(executionId);

        if (!execution || active(execution)) return;

        for (const listener of settledListeners)
          void Promise.resolve(listener(execution)).catch((error) =>
            console.error(
              "Settled execution handler failed",
              executionId,
              error,
            ),
          );
      });

      const snapshot = Effect.fn("Bots.snapshot")(function* (
        conversationId: string,
        options: { limit?: number | undefined },
      ) {
        const { agent: owner, conversation: found } =
          yield* conversation(conversationId);

        const read = yield* pi(() =>
          runtime.snapshot(owner, conversationId, options),
        );

        const latest = (yield* executions.list(owner.id)).find(
          (execution) => execution.conversationId === conversationId,
        );

        return {
          ...read,
          agentId: owner.id,
          conversation: found,
          error: latest?.status === "failed" ? latest.error : null,
        };
      });

      const origin = (execution: Execution): Effect.Effect<MessageOrigin> =>
        Effect.gen(function* () {
          if (isGroupTurn(execution)) return { kind: "group" };

          if (execution.scheduleId) {
            const schedule = yield* schedules.get(execution.scheduleId);

            return { kind: "task", name: schedule?.name ?? "Scheduled task" };
          }

          const [prefix, subject] = execution.requestId.split(":");

          if (prefix === "credential" && subject)
            return { kind: "credential", name: subject };

          if (prefix === "delegate" && subject) {
            const source = yield* agents.get(subject);

            return {
              kind: "bot",
              agentId: subject,
              name: source?.name ?? "Another bot",
            };
          }

          return { kind: "owner" };
        });

      const announcePreview = Effect.fnUntraced(function* (
        agentId: string,
        conversationId: string,
      ) {
        if (!activityListeners.size) return;
        const owner = yield* agents.get(agentId);

        if (!owner) return;
        const { messages } = yield* snapshot(conversationId, {});

        yield* emit({
          type: "chat-preview",
          agentId: owner.id,
          agentName: owner.name,
          lastMessage: latestMessagePreview(messages),
        });
      });

      /** Tells activity listeners which bot answered and how its reply begins. */
      const announceReply = Effect.fnUntraced(function* (execution: Execution) {
        if (!activityListeners.size) return;
        const owner = yield* agents.get(execution.agentId);

        if (!owner) return;
        const { messages } = yield* snapshot(execution.conversationId, {});

        yield* emit({
          type: "chat-preview",
          agentId: owner.id,
          agentName: owner.name,
          lastMessage: latestMessagePreview(messages),
        });

        const { reply, reaction } = latestReply(messages);

        // A reaction acknowledges the input without an answer worth a notification.
        if (!reply && reaction) return;

        yield* emit({
          type: "reply",
          executionId: execution.id,
          agentId: owner.id,
          agentName: owner.name,
          entryId: reply?.entryId ?? null,
          origin: (yield* origin(execution)).kind,
          preview: reply?.content.trim().slice(0, 240) ?? "",
          createdAt: execution.createdAt,
        });
      });

      const forkPreview = (
        agentId: string,
        conversationId: string,
        subject: string,
      ) =>
        announcePreview(agentId, conversationId).pipe(
          background("Chat preview announcement failed", subject),
          Effect.forkIn(scope),
          Effect.asVoid,
        );

      const chat = Effect.fn("Bots.chat")(function* (agentId: string) {
        let lock = chatOpenings.get(agentId);

        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          chatOpenings.set(agentId, lock);
        }

        return yield* Semaphore.withPermit(
          lock,
          Effect.gen(function* () {
            const owner = yield* agent(agentId);
            const saved = yield* settings.get(`chat:${agentId}`);

            const existing = Predicate.isString(saved)
              ? yield* conversations.get(saved)
              : null;

            const reopen = (found: Conversation) =>
              found.archived
                ? conversations
                    .setArchived(found.id, false)
                    .pipe(Effect.map((restored) => restored!))
                : Effect.succeed(found);

            if (existing?.agentId === agentId) return yield* reopen(existing);

            // Upgrades from session-based installs continue the most recent session's working context.
            const [legacy] = yield* conversations.list(agentId, true);

            const opened = legacy
              ? yield* reopen(legacy)
              : yield* conversations.create(
                  { agentId, title: owner.name },
                  yield* pi(() => runtime.openChat(owner)),
                );

            yield* settings.set(`chat:${agentId}`, opened.id);

            return opened;
          }),
        );
      });

      /** Waits for a submission's outcome and records it; closing the bots interrupts the wait, never the recording. */
      const monitor = Effect.fnUntraced(function* (
        execution: Execution,
        submissionId: string,
        owner: Agent,
      ) {
        const outcome = yield* Effect.result(
          Effect.tryPromise({
            try: () => runtime.wait(submissionId, owner),
            catch: (error) => error,
          }),
        );

        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (Result.isFailure(outcome)) {
              if (yield* executions.get(execution.id))
                yield* executions.update(execution.id, {
                  status: "failed",
                  error: String(
                    outcome.failure instanceof Error
                      ? outcome.failure.message
                      : outcome.failure,
                  ),
                });
              yield* changed(execution.conversationId);
              yield* settled(execution.id);

              return;
            }

            const result = outcome.success;
            const current = yield* executions.get(execution.id);

            if (!current || current.status === "cancelled")
              return yield* settled(execution.id);

            yield* executions.update(execution.id, {
              status: result.status === "done" ? "done" : "failed",
              error:
                result.status === "done"
                  ? null
                  : "detail" in result
                    ? Predicate.isString(result.detail)
                      ? result.detail
                      : result.reason
                    : "The agent could not answer this input",
            });
            yield* changed(execution.conversationId);
            yield* settled(execution.id);

            if (result.status === "done" && !isGroupTurn(execution))
              yield* announceReply(execution).pipe(
                background("Reply announcement failed", execution.id),
                Effect.forkIn(scope),
              );
          }),
        );
      });

      const admit = Effect.fnUntraced(function* (execution: Execution) {
        if (execution.status === "done" || execution.status === "cancelled")
          return;

        // Admission can fail after Pi has committed but before the host gets its ID.
        // Reuse the durable request ID; never create another user turn to recover it.
        if (execution.status === "failed" && execution.submissionId) return;
        const owner = yield* agent(execution.agentId);

        if (!owner.enabled) {
          yield* pi(() => runtime.abort(owner, execution.conversationId));
          yield* executions.update(execution.id, { status: "cancelled" });
          yield* changed(execution.conversationId);
          yield* settled(execution.id);

          return;
        }

        yield* Effect.gen(function* () {
          const submissionId =
            execution.submissionId ??
            (yield* Effect.gen(function* () {
              const from = yield* origin(execution);
              const attachments = yield* executions.attachments(execution.id);

              return yield* pi(() =>
                runtime.submit(
                  owner,
                  execution.conversationId,
                  execution.prompt,
                  execution.requestId,
                  {
                    replyTo: execution.replyTo ?? undefined,
                    origin: from,
                    attachments,
                  },
                ),
              );
            }));

          yield* executions.update(execution.id, {
            submissionId,
            status: "running",
          });
          yield* executions.clearAttachments(execution.id);
          yield* FiberMap.run(
            monitors,
            execution.id,
            monitor(execution, submissionId, owner),
            { onlyIfMissing: true },
          );
        }).pipe(
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.gen(function* () {
                  const error = Cause.squash(cause);

                  yield* executions.update(execution.id, {
                    status: "failed",
                    error: String(
                      error instanceof Error ? error.message : error,
                    ),
                  });
                  yield* changed(execution.conversationId);
                  yield* settled(execution.id);
                }),
          ),
        );
      });

      const send = Effect.fn("Bots.send")(function* (
        conversationId: string,
        content: string,
        requestId: string,
        options: {
          scheduleId?: string;
          replyTo?: string | undefined;
          attachments?: AttachmentInput[] | undefined;
        },
      ) {
        const { agent: owner } = yield* conversation(conversationId);

        if (!owner.enabled)
          return yield* Effect.fail(
            new Conflict({ message: "Enable this agent before starting work" }),
          );
        const replyTo = options.replyTo ?? null;
        const attachments = options.attachments ?? [];
        // Validate before anything is stored, so a bad file never leaves a failed execution behind.
        yield* appErrors(
          Effect.try({
            try: () => prepareAttachments(attachments),
            catch: (error) => error,
          }),
        );
        const attachmentsDigest = attachmentDigest(attachments);

        const existing = yield* executions.getByRequest(
          conversationId,
          requestId,
        );

        if (
          existing &&
          (existing.prompt !== content ||
            (existing.replyTo ?? null) !== replyTo ||
            (existing.attachmentsDigest ?? null) !== attachmentsDigest)
        )
          return yield* Effect.fail(
            new Conflict({
              message: "Request ID already used for a different message",
            }),
          );

        const execution =
          existing ??
          (yield* executions.create({
            agentId: owner.id,
            conversationId,
            scheduleId: options.scheduleId ?? null,
            requestId,
            prompt: content,
            replyTo,
            attachments,
            attachmentsDigest,
            submissionId: null,
            status: "pending",
            error: null,
          }));

        yield* admit(execution);
        yield* changed(conversationId);

        if (!isGroupTurn(execution))
          yield* forkPreview(execution.agentId, conversationId, execution.id);

        return (yield* executions.get(execution.id))!;
      });

      const notice = Effect.fn("Bots.notice")(function* (
        agentId: string,
        content: string,
        requestId: string,
      ) {
        return yield* send((yield* chat(agentId)).id, content, requestId, {});
      });

      const abort = Effect.fn("Bots.abort")(function* (conversationId: string) {
        const { agent: owner } = yield* conversation(conversationId);

        const running = (yield* executions.list(owner.id)).filter(
          (execution) =>
            execution.conversationId === conversationId && active(execution),
        );

        yield* pi(() => runtime.abort(owner, conversationId));

        for (const execution of running)
          if ((yield* executions.get(execution.id))?.status !== "done")
            yield* executions.update(execution.id, { status: "cancelled" });

        yield* changed(conversationId);

        for (const execution of running) yield* settled(execution.id);
      });

      // Takes notices for bots' chats, such as a saved credential's, until the bots close.
      yield* notices.handle((agentId, text, requestId) =>
        notice(agentId, text, requestId),
      );

      return Bots.of({
        agent,
        conversation,
        subscribe,
        onActivity,
        onSettled,
        agentPreviews: Effect.gen(function* () {
          return yield* Effect.forEach(
            yield* agents.list,
            Effect.fnUntraced(function* (each) {
              const [first] = yield* conversations.list(each.id, true);

              if (!first) return { agent: each, lastMessage: "" };

              const history = yield* Effect.promise(() =>
                runtime.history(each, { limit: 200 }),
              );

              return {
                agent: each,
                lastMessage: latestMessagePreview(history.messages),
              };
            }),
            { concurrency: "unbounded" },
          );
        }),
        announceJobAnswer: Effect.fn("Bots.announceJobAnswer")(function* (
          answer: JobAnswer,
        ) {
          const owner = yield* agents.get(answer.agentId);

          // Bots of another server in the same process are not this account's.
          if (!owner) return;

          yield* emit({
            type: "reply",
            executionId: answer.eventId,
            agentId: owner.id,
            agentName: owner.name,
            entryId: conversationReference(owner.id, Number(answer.entryId)),
            origin: answer.kind,
            jobName: answer.name,
            preview: answer.preview,
            createdAt: new Date().toISOString(),
          });
        }),
        announce: emit,
        snapshot: (conversationId, options = {}) =>
          snapshot(conversationId, options),
        chat,
        recordBotMessage: Effect.fn("Bots.recordBotMessage")(function* (
          agentId: string,
          event: BotMessageEvent,
          requestId: string,
        ) {
          const opened = yield* chat(agentId);
          const owner = yield* agent(agentId);

          yield* pi(() =>
            runtime.recordBotMessage(owner, opened.id, event, requestId),
          );
          yield* changed(opened.id);
          yield* forkPreview(agentId, opened.id, agentId);
        }),
        chatSnapshot: (agentId, options = {}) =>
          chat(agentId).pipe(
            Effect.flatMap((opened) => snapshot(opened.id, options)),
          ),
        history: (agentId, options) =>
          agent(agentId).pipe(
            Effect.flatMap((owner) =>
              pi(() => runtime.history(owner, options)),
            ),
          ),
        codingJobs: (agentId) =>
          agent(agentId).pipe(
            Effect.flatMap((owner) => pi(() => runtime.codingJobs(owner))),
          ),
        codingJobHistory: (agentId, name, options) =>
          agent(agentId).pipe(
            Effect.flatMap((owner) =>
              pi(() => runtime.codingJobHistory(owner, name, options)),
            ),
          ),
        desktopJobs: (agentId) =>
          agent(agentId).pipe(
            Effect.flatMap((owner) => pi(() => runtime.desktopJobs(owner))),
          ),
        desktopJobHistory: (agentId, name, options) =>
          agent(agentId).pipe(
            Effect.flatMap((owner) =>
              pi(() => runtime.desktopJobHistory(owner, name, options)),
            ),
          ),
        sendChat: Effect.fn("Bots.sendChat")(function* (
          agentId: string,
          content: string,
          requestId: string,
          replyTo?: string,
          attachments: AttachmentInput[] = [],
          timezone?: string,
        ) {
          if (timezone && isTimezone(timezone))
            yield* settings.set(OWNER_TIMEZONE, timezone);

          return yield* send((yield* chat(agentId)).id, content, requestId, {
            replyTo,
            attachments,
          });
        }),
        notice,
        send: (conversationId, content, requestId, options = {}) =>
          send(conversationId, content, requestId, options),
        dispatch: Effect.fn("Bots.dispatch")(function* (
          agentId: string,
          prompt: string,
          requestId: string,
          scheduleId: string,
        ) {
          const existing = (yield* executions.list(agentId)).find(
            (execution) => execution.requestId === requestId,
          );

          if (existing) {
            yield* admit(existing);

            return existing;
          }

          return yield* send((yield* chat(agentId)).id, prompt, requestId, {
            scheduleId,
          });
        }),
        recover: Effect.gen(function* () {
          for (const execution of (yield* executions.list()).filter(active))
            yield* admit(execution).pipe(
              background("Execution recovery failed", execution.id),
            );
        }),
        compact: Effect.fn("Bots.compact")(function* (agentId: string) {
          const owner = yield* agent(agentId);
          const opened = yield* chat(agentId);
          const taskId = yield* pi(() => runtime.compact(owner, opened.id));
          yield* changed(opened.id);

          return taskId;
        }),
        abortChat: (agentId) =>
          chat(agentId).pipe(Effect.flatMap((opened) => abort(opened.id))),
        abort,
        deleteAgent: Effect.fn("Bots.deleteAgent")(function* (id: string) {
          yield* agent(id);

          for (const each of yield* conversations.list(id))
            yield* abort(each.id);
          yield* pi(() => runtime.deleteAgent(id));
          yield* agents.delete(id);
        }),
      });
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

export function standaloneBots(
  store: Store,
  runtime: AgentRuntime,
): BotsAccess & {
  store: Store;
  /** The store's account, for code that reads its repositories. */
  core: Store["runtime"];
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
          store.runtime.runSync(
            Effect.context<Exclude<StandaloneServices, Bots | BotRuntime>>(),
          ),
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
