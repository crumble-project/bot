import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  type Context as PiContext,
} from "@earendil-works/chord/context";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { type Agent, type Execution } from "../shared/domain";
import { appErrors } from "../shared/app-errors";
import { SettingsRepository } from "../shared/settings-repository";
import { AgentRepository } from "../bots/agent-repository";
import { Bots, delegationRequest } from "../bots/bots";
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
    ) => Effect.Effect<
      Receipt & { error: string | null; response: string[] },
      AppError
    >;
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
        yield* record(from.id, from.id, execution, "sent", message);
        yield* record(target.id, from.id, execution, "sent", message);

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

        if (active(execution) && execution.submissionId && waitMs > 0) {
          const submissionId = execution.submissionId;
          const target = yield* bots.agent(execution.agentId);

          // The wait gives up quietly after `waitMs`; a cancelled tool call or a failed wait still fails.
          yield* Effect.tryPromise({
            try: (signal) =>
              runtime.wait(
                submissionId,
                target,
                withAbortSignal(signal, context),
              ),
            catch: (error) => error,
          }).pipe(
            Effect.timeoutOption(waitMs),
            Effect.catch((error) =>
              checkAborted(context).pipe(
                Effect.andThen(appErrors(Effect.fail(error))),
                Effect.as(Option.none()),
              ),
            ),
          );

          execution = yield* exchange(sourceId, executionId);
        }

        // Only a completed answer belongs to the caller. Partial output and other
        // turns in the recipient's chat remain private.
        const { submissionId, conversationId } = execution;
        const answering = yield* bots.agent(execution.agentId);

        const response =
          execution.status === "done" && submissionId
            ? yield* pi(async () =>
                runtime.response(answering, conversationId, submissionId),
              )
            : [];

        yield* exchange(sourceId, executionId);

        if (
          execution.status === "done" ||
          execution.status === "failed" ||
          execution.status === "cancelled"
        )
          yield* record(
            sourceId,
            sourceId,
            execution,
            execution.status,
            response.join("\n\n") ||
              execution.error ||
              (execution.status === "done"
                ? "The bot returned no text answer."
                : "The bot exchange was cancelled."),
          );

        yield* exchange(sourceId, executionId);

        return {
          ...(yield* receipt(execution)),
          error: execution.error,
          response,
        };
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
