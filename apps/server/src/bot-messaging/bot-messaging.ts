import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  type Context as PiContext,
} from "@earendil-works/chord/context";
import { Clock, Context, Effect, Layer, Option } from "effect";
import { activeExecution, type Execution } from "../shared/domain";
import { type Agent } from "../contract/agents";
import { appErrors, pi } from "../shared/app-errors";
import {
  botMessageRequest,
  delegationRequest,
  jobQuestionRequest,
  parseRequestId,
} from "../shared/request-ids";
import { AgentRepository } from "../bot-store/agent-repository";
import { Bots } from "../bots/bots";
import type { JobAsked, TurnWork } from "../jobs/jobs";
import { ExecutionRepository } from "../bot-store/execution-repository";
import { BotRuntime } from "../bots/runtime";
import {
  InvalidInput,
  Forbidden,
  NotFound,
  Conflict,
  type AppError,
} from "../shared/errors";
import { BOT_TOOL } from "../contract/tools";
import { normalize } from "../group-chats/group-mentions";
import { MAX_MESSAGE_CHARS, MAX_WAIT_SECONDS } from "../shared/limits";
import { delegationStore } from "./delegation-store";

type Receipt = {
  executionId: string;
  agentId: string;
  agent: string;
  status: Execution["status"];
};

type DelegationResult = Receipt & { error: string | null; response: string[] };

type JobQuestionAnswered = { agentId: string; agent: string; job: string };

const JOB_POLL_MS = 500;

const addressed = (recipient: string) => recipient.trim().replace(/^@/, "");

/** Throws the abort reason once the tool call is cancelled, as Pi tools do. */
const checkAborted = (context: PiContext) =>
  Effect.sync(() => context.abortSignal?.throwIfAborted());

const sendableText = (input: {
  message: string;
  requestId: string;
}): Effect.Effect<string, InvalidInput> => {
  const message = input.message.trim();

  if (!message || message.length > MAX_MESSAGE_CHARS)
    return Effect.fail(
      new InvalidInput({
        message: `A bot message must contain 1–${MAX_MESSAGE_CHARS} characters`,
      }),
    );

  if (!input.requestId)
    return Effect.fail(
      new InvalidInput({ message: "A bot message needs a request ID" }),
    );

  return Effect.succeed(message);
};

const jobQuestionText = (asked: JobAsked, assignee: string) => {
  const { question } = asked;

  const options = question.options
    ? `\nOptions: ${question.options.join("; ")}${question.multiple ? " (several may apply)" : ""}`
    : "";

  return `The ${asked.label} "${asked.name}", working on the task you delegated to me, asks:\n\n${question.text}${options}\n\nIf your brief or what you know settles it, answer with answer_job_question (questionId "${question.id}"). If only the owner can decide, don't guess: tell the owner, who can answer it in ${assignee}'s chat.`;
};

type Outcome = Pick<Execution, "status" | "error">;

const outcomeOf = (
  execution: Execution,
  work: TurnWork | undefined,
): Outcome => {
  if (work?.open) return { status: "running", error: execution.error };

  if (work?.error !== undefined) return { status: "failed", error: work.error };

  return { status: execution.status, error: execution.error };
};

const closingText = (
  status: Execution["status"],
  response: string[],
  error: string | null,
) =>
  response.join("\n\n") ||
  error ||
  (status === "done"
    ? "The bot returned no text answer."
    : "The bot exchange was cancelled.");

export class BotMessaging extends Context.Service<
  BotMessaging,
  {
    readonly recipients: (
      sourceId: string,
    ) => Effect.Effect<
      { id: string; name: string; description: string }[],
      AppError
    >;
    readonly send: (
      sourceId: string,
      input: { recipient: string; message: string; requestId: string },
      context?: PiContext,
    ) => Effect.Effect<Receipt, AppError>;
    readonly result: (
      sourceId: string,
      executionId: string,
      options?: { waitMs?: number; context?: PiContext },
    ) => Effect.Effect<DelegationResult, AppError>;
    /**
     * Passes a job's question to the bot that delegated the job's task, as a turn in that bot's chat. False when the
     * job's work came from no delegation, or its bot may no longer message the job's bot: the owner answers then.
     */
    readonly relayQuestion: (
      asked: JobAsked,
    ) => Effect.Effect<boolean, AppError>;
    /** The delegating bot's answer to a job question relayed to it; fails once the question was answered. */
    readonly answerQuestion: (
      sourceId: string,
      input: { questionId: string; answer: string },
    ) => Effect.Effect<JobQuestionAnswered, AppError>;
  }
>()("crumble/bot-messaging/BotMessaging") {
  static readonly layer = Layer.effect(
    BotMessaging,
    Effect.gen(function* () {
      const bots = yield* Bots;
      const runtime = yield* BotRuntime;
      const agents = yield* AgentRepository;
      const executions = yield* ExecutionRepository;
      const delegations = yield* delegationStore;

      const source = Effect.fnUntraced(function* (sourceId: string) {
        const found = yield* bots.agent(sourceId);

        if (!found.enabled || !found.tools.includes(BOT_TOOL.delegate))
          return yield* Effect.fail(
            new Forbidden({
              message: "This bot has no permission to message other bots",
            }),
          );

        return found;
      });

      const resolve = Effect.fnUntraced(function* (recipient: string) {
        const reference = addressed(recipient);
        const byId = yield* agents.get(reference);

        if (byId) return byId;

        const matches = (yield* agents.list).filter(
          (agent) => normalize(agent.name) === normalize(reference),
        );

        if (!matches.length)
          return yield* Effect.fail(
            new NotFound({
              message: "Bot not found; use list_bots to find a recipient",
            }),
          );

        if (matches.length > 1)
          return yield* Effect.fail(
            new Conflict({
              message: "Bot name is ambiguous; use the ID from list_bots",
            }),
          );

        return matches[0]!;
      });

      const assertCanSend = Effect.fnUntraced(function* (sourceId: string) {
        if (
          (yield* executions.active(sourceId)).some(
            (execution) =>
              parseRequestId(execution.requestId).kind === "delegate",
          )
        )
          return yield* Effect.fail(
            new Conflict({
              message: "Delegated tasks cannot start further delegations",
            }),
          );
      });

      const authorize = (from: Agent, target: Agent) => {
        if (!target.enabled || target.id === from.id)
          return Effect.fail(
            new InvalidInput({ message: "Choose another enabled bot" }),
          );

        return Effect.void;
      };

      const exchange = Effect.fnUntraced(function* (
        sourceId: string,
        executionId: string,
      ) {
        const saved = yield* delegations.receipt(executionId);
        const from = yield* source(sourceId);

        if (saved?.sourceAgentId !== from.id)
          return yield* Effect.fail(
            new NotFound({ message: "Delegation receipt not found" }),
          );
        const execution = yield* executions.get(executionId);

        if (!execution || execution.agentId !== saved.targetAgentId)
          return yield* Effect.fail(
            new NotFound({ message: "Delegation execution not found" }),
          );

        return execution;
      });

      const receipt = Effect.fnUntraced(function* (execution: Execution) {
        return {
          executionId: execution.id,
          agentId: execution.agentId,
          agent: (yield* bots.agent(execution.agentId)).name,
          status: execution.status,
        };
      });

      /** Writes the exchange's message into the transcript of `sourceId`, the bot that sent the request. */
      const record = Effect.fnUntraced(function* (
        sourceId: string,
        execution: Execution,
        status: "sent" | "done" | "failed" | "cancelled",
        content: string,
      ) {
        const from = yield* bots.agent(sourceId);
        const target = yield* bots.agent(execution.agentId);

        const [sender, receiver] =
          status === "done" ? [target, from] : [from, target];

        yield* bots.recordBotMessage(
          sourceId,
          {
            content,
            communication: {
              executionId: execution.id,
              fromAgentId: sender.id,
              fromName: sender.name,
              toAgentId: receiver.id,
              toName: receiver.name,
              status,
            },
          },
          botMessageRequest(execution.id, status),
        );
      });

      const jobsOf = (answering: Agent, execution: Execution) => {
        const { submissionId } = execution;

        return execution.status === "done" && submissionId
          ? pi(() => runtime.turnWork(answering, submissionId)).pipe(
              Effect.map(Option.some),
            )
          : Effect.succeed(Option.none<TurnWork>());
      };

      const awaitTurn = (
        execution: Execution,
        submissionId: string,
        waitMs: number,
        context: PiContext,
      ) =>
        bots.agent(execution.agentId).pipe(
          Effect.flatMap((target) =>
            Effect.tryPromise({
              try: (signal) =>
                runtime.wait(
                  submissionId,
                  target,
                  withAbortSignal(signal, context),
                ),
              catch: (error) => error,
            }),
          ),
          Effect.timeoutOption(waitMs),
          Effect.catch((error) =>
            checkAborted(context).pipe(
              Effect.andThen(appErrors(Effect.fail(error))),
              Effect.as(Option.none()),
            ),
          ),
        );

      const awaitJobs = Effect.fnUntraced(function* (
        answering: Agent,
        execution: Execution,
        deadline: number,
        context: PiContext,
      ) {
        let work = Option.getOrUndefined(yield* jobsOf(answering, execution));

        while (work?.open) {
          const left = deadline - (yield* Clock.currentTimeMillis);

          if (left <= 0) break;
          yield* Effect.sleep(Math.min(JOB_POLL_MS, left));
          yield* checkAborted(context);
          work = Option.getOrUndefined(yield* jobsOf(answering, execution));
        }

        return work;
      });

      // Only completed answers belong to the caller. Partial output and other
      // turns in the recipient's chat remain private.
      const turnResponse = (
        answering: Agent,
        { status, submissionId, conversationId }: Execution,
        reports: string[],
      ): Effect.Effect<string[], AppError> =>
        status === "done" && submissionId
          ? pi(async () =>
              (
                await Promise.all(
                  [submissionId, ...reports].map((id) =>
                    runtime.response(answering, conversationId, id),
                  ),
                )
              ).flat(),
            )
          : Effect.succeed([]);

      // Reserve the destination before awaiting chat admission. A replay cannot send
      // the same tool invocation to a second bot or change its message.
      const reserveTarget = Effect.fnUntraced(function* (
        from: Agent,
        addressee: string,
        requestId: string,
        message: string,
      ) {
        const saved = yield* delegations.request(requestId);
        const recipient = normalize(addressed(addressee));

        // An in-flight tool keeps its resolved destination if the bot is renamed.
        const target =
          saved?.recipient === recipient
            ? yield* bots.agent(saved.targetAgentId)
            : yield* resolve(addressee);

        yield* authorize(from, target);

        if (
          saved &&
          (saved.targetAgentId !== target.id || saved.message !== message)
        )
          return yield* Effect.fail(
            new Conflict({
              message: "Request ID already used for a different bot message",
            }),
          );

        if (!saved)
          yield* delegations.reserve({
            requestId,
            sourceAgentId: from.id,
            targetAgentId: target.id,
            recipient,
            message,
          });

        return target;
      });

      const waitedFor = Effect.fnUntraced(function* (
        sourceId: string,
        execution: Execution,
        waitMs: number,
        context: PiContext,
      ) {
        if (
          !activeExecution(execution) ||
          !execution.submissionId ||
          waitMs <= 0
        )
          return execution;

        yield* awaitTurn(execution, execution.submissionId, waitMs, context);

        return yield* exchange(sourceId, execution.id);
      });

      return BotMessaging.of({
        recipients: Effect.fn("BotMessaging.recipients")(function* (
          sourceId: string,
        ) {
          const from = yield* source(sourceId);

          return (yield* agents.list)
            .filter((agent) => agent.id !== from.id && agent.enabled)
            .map(({ id, name, description }) => ({ id, name, description }));
        }),
        send: Effect.fn("BotMessaging.send")(function* (
          sourceId: string,
          input: { recipient: string; message: string; requestId: string },
          context: PiContext = BACKGROUND_CONTEXT,
        ) {
          yield* checkAborted(context);
          const from = yield* source(sourceId);
          const message = yield* sendableText(input);
          yield* assertCanSend(from.id);

          const requestId = delegationRequest(from.id, input.requestId);

          const target = yield* reserveTarget(
            from,
            input.recipient,
            requestId,
            message,
          );

          const chat = yield* bots.chat(target.id);
          yield* checkAborted(context);
          // Opening a chat may yield: recheck permissions and capacity immediately before send.
          yield* authorize(
            yield* source(from.id),
            yield* bots.agent(target.id),
          );
          yield* assertCanSend(from.id);
          const existing = yield* executions.getByRequest(chat.id, requestId);

          if (!existing && (yield* executions.active(target.id)).length >= 4)
            return yield* Effect.fail(
              new Conflict({
                message:
                  "This bot already has four active tasks; try again later",
              }),
            );
          const execution = yield* bots.send(chat.id, message, requestId);
          yield* delegations.saveReceipt({
            executionId: execution.id,
            sourceAgentId: from.id,
            targetAgentId: target.id,
          });
          yield* record(from.id, execution, "sent", message);

          return yield* receipt(execution);
        }),
        result: Effect.fn("BotMessaging.result")(function* (
          sourceId: string,
          executionId: string,
          options: { waitMs?: number; context?: PiContext } = {},
        ) {
          const first = yield* exchange(sourceId, executionId);
          const context = options.context ?? BACKGROUND_CONTEXT;
          yield* checkAborted(context);

          const waitMs = Math.min(
            MAX_WAIT_SECONDS * 1000,
            Math.max(0, options.waitMs ?? 0),
          );

          const deadline = (yield* Clock.currentTimeMillis) + waitMs;
          const execution = yield* waitedFor(sourceId, first, waitMs, context);
          const answering = yield* bots.agent(execution.agentId);

          const work = yield* awaitJobs(
            answering,
            execution,
            deadline,
            context,
          );

          const { status, error } = outcomeOf(execution, work);

          const response =
            status === "running"
              ? []
              : yield* turnResponse(answering, execution, work?.reports ?? []);

          yield* exchange(sourceId, executionId);

          if (status !== "pending" && status !== "running")
            yield* record(
              sourceId,
              execution,
              status,
              closingText(status, response, error),
            );

          yield* exchange(sourceId, executionId);

          return {
            ...(yield* receipt(execution)),
            status,
            error,
            response,
          };
        }),
        relayQuestion: Effect.fn("BotMessaging.relayQuestion")(function* (
          asked: JobAsked,
        ) {
          const found = yield* Effect.forEach(asked.turn, (id) =>
            executions.findBySubmission(asked.agentId, id),
          );

          const delegation = found.find(
            (execution) =>
              execution &&
              parseRequestId(execution.requestId).kind === "delegate",
          );

          if (!delegation) return false;

          const saved = yield* delegations.receipt(delegation.id);

          if (saved?.targetAgentId !== asked.agentId) return false;

          const permitted = yield* Effect.option(
            Effect.gen(function* () {
              const reporter = yield* source(saved.sourceAgentId);
              const assignee = yield* bots.agent(asked.agentId);
              yield* authorize(reporter, assignee);

              return { reporter, assignee };
            }),
          );

          if (Option.isNone(permitted)) return false;
          const { reporter, assignee } = permitted.value;

          yield* delegations.saveQuestion({
            questionId: asked.question.id,
            reporterAgentId: reporter.id,
            assigneeAgentId: assignee.id,
            kind: asked.kind,
            job: asked.name,
          });
          const chat = yield* bots.chat(reporter.id);

          yield* bots.send(
            chat.id,
            jobQuestionText(asked, assignee.name),
            jobQuestionRequest(assignee.id, asked.question.id),
          );

          return true;
        }),
        answerQuestion: Effect.fn("BotMessaging.answerQuestion")(function* (
          sourceId: string,
          input: { questionId: string; answer: string },
        ) {
          const from = yield* source(sourceId);

          const saved = yield* delegations.question(input.questionId);

          if (saved?.reporterAgentId !== from.id)
            return yield* Effect.fail(
              new NotFound({ message: "Job question not found" }),
            );

          const assignee = yield* bots.agent(saved.assigneeAgentId);
          yield* authorize(from, assignee);

          yield* bots.answerJob(assignee.id, saved.kind, {
            name: saved.job,
            questionId: input.questionId,
            text: input.answer,
            by: `${from.name}, the bot that delegated your task,`,
          });

          return { agentId: assignee.id, agent: assignee.name, job: saved.job };
        }),
      });
    }),
  );
}
