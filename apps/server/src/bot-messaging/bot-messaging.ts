import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  type Context as PiContext,
} from "@earendil-works/chord/context";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { type Agent, type Execution } from "../shared/domain";
import { appErrors } from "../shared/app-errors";
import { SettingsRepository } from "../shared/settings-repository";
import { AgentRepository } from "../bots/agent-repository";
import { Bots, delegationRequest, jobQuestionRequest } from "../bots/bots";
import type { JobAsked, TurnWork } from "../jobs/jobs";
import { ExecutionRepository } from "../bots/execution-repository";
import { BotRuntime } from "../bots/runtime";
import type { Runner } from "../shared/runner";
import {
  InvalidInput,
  Forbidden,
  NotFound,
  Conflict,
  type AppError,
} from "../shared/errors";

type Receipt = {
  executionId: string;
  agentId: string;
  agent: string;
  status: Execution["status"];
};

type DelegationResult = Receipt & { error: string | null; response: string[] };

/** A job's answered question, as the tool that answered it reports. */
type JobQuestionAnswered = { agentId: string; agent: string; job: string };

const JOB_POLL_MS = 500;

const active = (execution: Execution) =>
  execution.status === "pending" || execution.status === "running";

const normalize = (name: string) => name.normalize("NFKC").toLowerCase();

/** Throws the abort reason once the tool call is cancelled, as Pi tools do. */
const checkAborted = (context: PiContext) =>
  Effect.sync(() => context.abortSignal?.throwIfAborted());

/** Who sent a bot message to whom, saved under `delegation-receipt:<execution ID>`. */
const savedReceipt = Schema.decodeUnknownOption(
  Schema.Struct({ sourceAgentId: Schema.String, targetAgentId: Schema.String }),
);

/** A job question relayed to the bot that delegated the job's task, saved under `job-question:<question ID>`. */
const savedQuestion = Schema.decodeUnknownOption(
  Schema.Struct({
    reporterAgentId: Schema.String,
    assigneeAgentId: Schema.String,
    kind: Schema.String,
    job: Schema.String,
  }),
);

/** What the delegating bot reads: whose job asks what, and how to answer or hand it to the owner. */
const jobQuestionText = (asked: JobAsked, assignee: string) => {
  const { question } = asked;

  const options = question.options
    ? `\nOptions: ${question.options.join("; ")}${question.multiple ? " (several may apply)" : ""}`
    : "";

  return `The ${asked.label} "${asked.name}", working on the task you delegated to me, asks:\n\n${question.text}${options}\n\nIf your brief or what you know settles it, answer with answer_job_question (questionId "${question.id}"). If only the owner can decide, don't guess: tell the owner, who can answer it in ${assignee}'s chat.`;
};

/** A delegation's status once its turn's jobs count: running while one works, failed when one failed. */
type Outcome = Pick<Execution, "status" | "error">;

const outcomeOf = (
  execution: Execution,
  work: TurnWork | undefined,
): Outcome => {
  if (work?.open) return { status: "running", error: execution.error };

  if (work?.error !== undefined) return { status: "failed", error: work.error };

  return { status: execution.status, error: execution.error };
};

/** The text of the card closing a delegation: the answer, else the error, else why there is none. */
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

/** A sent bot message's destination, reserved under `bot-message-request:<request ID>`. */
const savedRequest = Schema.decodeUnknownOption(
  Schema.Struct({
    targetAgentId: Schema.String,
    recipient: Schema.String,
    message: Schema.String,
  }),
);

/** Bot addressing and exchanges over the existing durable execution transport. */
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
  static readonly make = Effect.gen(function* () {
    const bots = yield* Bots;
    const runtime = yield* BotRuntime;
    const agents = yield* AgentRepository;
    const executions = yield* ExecutionRepository;
    const settings = yield* SettingsRepository;

    const pi = <A>(run: () => Promise<A>) =>
      appErrors(Effect.tryPromise({ try: run, catch: (error) => error }));

    const source = Effect.fnUntraced(function* (sourceId: string) {
      const found = yield* bots.agent(sourceId);

      if (!found.enabled || !found.tools.includes("delegate"))
        return yield* Effect.fail(
          new Forbidden({
            message: "This agent has no permission to message other bots",
          }),
        );

      return found;
    });

    const resolve = Effect.fnUntraced(function* (recipient: string) {
      const reference = recipient.trim().replace(/^@/, "");
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
        (yield* executions.list(sourceId)).some(
          (execution) =>
            active(execution) && execution.requestId.startsWith("delegate:"),
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
          new InvalidInput({ message: "Choose another enabled agent" }),
        );

      if (!from.delegates.includes(target.id))
        return Effect.fail(
          new Forbidden({
            message: "This agent has no permission to delegate to that agent",
          }),
        );

      return Effect.void;
    };

    const exchange = Effect.fnUntraced(function* (
      sourceId: string,
      executionId: string,
    ) {
      const saved = savedReceipt(
        yield* settings.get(`delegation-receipt:${executionId}`),
      ).pipe(Option.getOrUndefined);

      const from = yield* source(sourceId);

      if (
        saved?.sourceAgentId !== from.id ||
        !from.delegates.includes(saved.targetAgentId)
      )
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

    const record = Effect.fnUntraced(function* (
      transcriptAgentId: string,
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
        transcriptAgentId,
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
        `bot-message:${execution.id}:${status}`,
      );
    });

    /** The work of the jobs a finished turn started or messaged; none for a turn still running. */
    const jobsOf = (answering: Agent, execution: Execution) => {
      const { submissionId } = execution;

      return execution.status === "done" && submissionId
        ? pi(() => runtime.turnWork(answering, submissionId))
        : Effect.succeed(undefined);
    };

    // The wait gives up quietly after `waitMs`; a cancelled tool call or a failed wait still fails.
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

    // A turn that left jobs working answers once their reports are answered too.
    const awaitJobs = Effect.fnUntraced(function* (
      answering: Agent,
      execution: Execution,
      deadline: number,
      context: PiContext,
    ) {
      let work = yield* jobsOf(answering, execution);

      while (work?.open) {
        const left = deadline - (yield* Clock.currentTimeMillis);

        if (left <= 0) break;
        yield* Effect.sleep(Math.min(JOB_POLL_MS, left));
        yield* checkAborted(context);
        work = yield* jobsOf(answering, execution);
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

    return BotMessaging.of({
      recipients: Effect.fn("BotMessaging.recipients")(function* (
        sourceId: string,
      ) {
        const from = yield* source(sourceId);

        return (yield* agents.list)
          .filter(
            (agent) =>
              agent.id !== from.id &&
              agent.enabled &&
              from.delegates.includes(agent.id),
          )
          .map(({ id, name, description }) => ({ id, name, description }));
      }),
      send: Effect.fn("BotMessaging.send")(function* (
        sourceId: string,
        input: { recipient: string; message: string; requestId: string },
        context: PiContext = BACKGROUND_CONTEXT,
      ) {
        yield* checkAborted(context);
        const from = yield* source(sourceId);
        const message = input.message.trim();

        if (!message || message.length > 32000)
          return yield* Effect.fail(
            new InvalidInput({
              message: "A bot message must contain 1–32000 characters",
            }),
          );

        if (!input.requestId)
          return yield* Effect.fail(
            new InvalidInput({ message: "A bot message needs a request ID" }),
          );
        yield* assertCanSend(from.id);

        const requestId = delegationRequest(from.id, input.requestId);
        const key = `bot-message-request:${requestId}`;

        const saved = savedRequest(yield* settings.get(key)).pipe(
          Option.getOrUndefined,
        );

        const recipient = normalize(input.recipient.trim().replace(/^@/, ""));

        // An in-flight tool keeps its resolved destination if the bot is renamed.
        const target =
          saved?.recipient === recipient
            ? yield* bots.agent(saved.targetAgentId)
            : yield* resolve(input.recipient);

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

        // Reserve the destination before awaiting chat admission. A replay cannot send
        // the same tool invocation to a second bot or change its message.
        if (!saved)
          yield* settings.set(key, {
            targetAgentId: target.id,
            recipient,
            message,
          });
        const chat = yield* bots.chat(target.id);
        yield* checkAborted(context);
        // Opening a chat may yield: recheck permissions and capacity immediately before send.
        yield* authorize(yield* source(from.id), yield* bots.agent(target.id));
        yield* assertCanSend(from.id);
        const existing = yield* executions.getByRequest(chat.id, requestId);

        if (
          !existing &&
          (yield* executions.list(target.id)).filter(active).length >= 4
        )
          return yield* Effect.fail(
            new Conflict({
              message:
                "This agent already has four active tasks; try again later",
            }),
          );
        const execution = yield* bots.send(chat.id, message, requestId);
        yield* settings.set(`delegation-receipt:${execution.id}`, {
          sourceAgentId: from.id,
          targetAgentId: target.id,
        });
        // The target's chat already shows the delivered message as from the sender.
        yield* record(from.id, from.id, execution, "sent", message);

        return yield* receipt(execution);
      }),
      result: Effect.fn("BotMessaging.result")(function* (
        sourceId: string,
        executionId: string,
        options: { waitMs?: number; context?: PiContext } = {},
      ) {
        let execution = yield* exchange(sourceId, executionId);
        const context = options.context ?? BACKGROUND_CONTEXT;
        yield* checkAborted(context);
        const waitMs = Math.min(60000, Math.max(0, options.waitMs ?? 0));
        const deadline = (yield* Clock.currentTimeMillis) + waitMs;

        if (active(execution) && execution.submissionId && waitMs > 0) {
          yield* awaitTurn(execution, execution.submissionId, waitMs, context);
          execution = yield* exchange(sourceId, executionId);
        }

        const answering = yield* bots.agent(execution.agentId);
        const work = yield* awaitJobs(answering, execution, deadline, context);

        const { status, error } = outcomeOf(execution, work);

        const response =
          status === "running"
            ? []
            : yield* turnResponse(answering, execution, work?.reports ?? []);

        yield* exchange(sourceId, executionId);

        if (status !== "pending" && status !== "running")
          yield* record(
            sourceId,
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

        const delegation = found.find((execution) =>
          execution?.requestId.startsWith("delegate:"),
        );

        if (!delegation) return false;

        const saved = savedReceipt(
          yield* settings.get(`delegation-receipt:${delegation.id}`),
        ).pipe(Option.getOrUndefined);

        if (saved?.targetAgentId !== asked.agentId) return false;

        // Without the permission to message the job's bot now, the question stays with the owner.
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

        yield* settings.set(`job-question:${asked.question.id}`, {
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

        const saved = savedQuestion(
          yield* settings.get(`job-question:${input.questionId}`),
        ).pipe(Option.getOrUndefined);

        if (saved?.reporterAgentId !== from.id)
          return yield* Effect.fail(
            new NotFound({ message: "Job question not found" }),
          );

        if (saved.kind !== "coding")
          return yield* Effect.fail(
            new InvalidInput({
              message: "Only coding job questions can be answered here",
            }),
          );
        const assignee = yield* bots.agent(saved.assigneeAgentId);
        yield* authorize(from, assignee);

        yield* bots.answerCodingJob(assignee.id, {
          name: saved.job,
          questionId: input.questionId,
          text: input.answer,
          by: `${from.name}, the bot that delegated your task,`,
        });

        return { agentId: assignee.id, agent: assignee.name, job: saved.job };
      }),
    });
  });

  static readonly layer = Layer.effect(BotMessaging, BotMessaging.make);
}

/** Bot messaging for code outside Effect, such as tests, with the Promise API it had. */
export const botMessagingAccess = (messaging: BotMessaging["Service"]) => ({
  recipients: (sourceId: string) =>
    Effect.runSync(messaging.recipients(sourceId)),
  send: (
    sourceId: string,
    input: { recipient: string; message: string; requestId: string },
    context?: PiContext,
  ) => Effect.runPromise(messaging.send(sourceId, input, context)),
  result: (
    sourceId: string,
    executionId: string,
    options?: { waitMs?: number; context?: PiContext },
  ) => Effect.runPromise(messaging.result(sourceId, executionId, options)),
  relayQuestion: (asked: JobAsked) =>
    Effect.runPromise(messaging.relayQuestion(asked)),
  answerQuestion: (
    sourceId: string,
    input: { questionId: string; answer: string },
  ) => Effect.runPromise(messaging.answerQuestion(sourceId, input)),
});

/** Bot messaging over standalone bots, for a test without an account. */
export const standaloneMessaging = (bots: {
  effects: Runner<
    | Bots
    | BotRuntime
    | AgentRepository
    | ExecutionRepository
    | SettingsRepository
  >;
}) => bots.effects.runSync(BotMessaging.make);
