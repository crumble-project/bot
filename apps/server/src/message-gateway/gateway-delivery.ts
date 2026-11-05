import { Cause, Clock, Effect, Fiber, Result, Semaphore } from "effect";
import { AgentRepository } from "../bots/agent-repository";
import { Bots } from "../bots/bots";
import { ExecutionRepository } from "../bots/execution-repository";
import { BotRuntime } from "../bots/runtime";
import type { Agent } from "../contract/agents";
import { activeExecution } from "../shared/domain";
import { backoff } from "../shared/reconnecting";
import {
  GatewayTransportError,
  type ChatAdapter,
  type GatewayConnection,
  type GatewayMessage,
} from "./adapter";
import { transport, type GatewayConnections } from "./gateway-connections";
import { GatewayRepository, type GatewayReceipt } from "./gateway-repository";
import { authorizedMessage, gatewayChunks } from "./routing";

const MAX_RECEIPT_ATTEMPTS = 10;

const retryDelay = (attempt: number) => backoff(5000, attempt);

const receiptKey = (receipt: GatewayReceipt) =>
  `${receipt.adapterId}:${receipt.messageId}`;

const receiptMessage = (receipt: GatewayReceipt): GatewayMessage => ({
  id: receipt.messageId,
  channelId: receipt.channelId,
  senderId: receipt.senderId,
  text: receipt.text,
  isDirectMessage: receipt.isDirectMessage,
});

/** Carries each stored receipt to its bot and the bot's answer back, over whatever connection is current. */
export const receiptDelivery = Effect.fnUntraced(function* (
  adapters: readonly ChatAdapter[],
  connections: GatewayConnections,
) {
  const agents = yield* AgentRepository;
  const bots = yield* Bots;
  const runtime = yield* BotRuntime;
  const executions = yield* ExecutionRepository;
  const receipts = yield* GatewayRepository;
  const scope = yield* Effect.scope;
  const processing = Semaphore.makeUnsafe(1);

  const workers = new Map<
    string,
    { adapterId: string; channelId: string; fiber: Fiber.Fiber<void> }
  >();

  const cancelWorkers = Effect.fnUntraced(function* (adapterId: string) {
    for (const worker of workers.values())
      if (worker.adapterId === adapterId) yield* Fiber.interrupt(worker.fiber);
  });

  const receiptExecution = Effect.fnUntraced(function* (
    receipt: GatewayReceipt,
    botId: string,
    generation: number,
  ) {
    let execution = receipt.executionId
      ? yield* executions.get(receipt.executionId)
      : null;

    if (!execution)
      execution = yield* executions.findByRequest(botId, receipt.requestId);

    if (execution) return execution;

    if (!connections.live(receipt.adapterId, generation)) return null;
    execution = yield* bots.sendChat(botId, receipt.text, receipt.requestId);
    receipt.executionId = execution.id;
    yield* receipts.save(receipt);

    return execution;
  });

  const botResponse = Effect.fnUntraced(function* (
    receipt: GatewayReceipt,
    agent: Agent,
    generation: number,
  ) {
    const execution = yield* receiptExecution(
      receipt,
      receipt.botId!,
      generation,
    );

    if (!execution) return null;

    if (activeExecution(execution)) return null;

    if (execution.status !== "done")
      return [
        "The bot could not complete this message. Send a new message to try again.",
      ];

    if (!execution.submissionId)
      return ["The bot completed without a response identifier."];

    const response = yield* transport(() =>
      runtime.response(
        agent,
        execution.conversationId,
        execution.submissionId!,
      ),
    );

    return [
      response.join("\n\n") || "The bot completed without a text response.",
    ];
  });

  const prepareReceipt = Effect.fnUntraced(function* (
    receipt: GatewayReceipt,
    adapter: ChatAdapter,
    generation: number,
  ) {
    if (receipt.chunks !== null || !receipt.botId) return true;
    const agent = yield* agents.get(receipt.botId);

    const chunks =
      !agent || !agent.enabled
        ? [
            "The selected bot is unavailable or disabled. Enable it before sending another message.",
          ]
        : yield* botResponse(receipt, agent, generation);

    if (chunks === null) return false;
    receipt.chunks = chunks.flatMap((text) =>
      gatewayChunks(text, adapter.maxMessageLength),
    );
    yield* receipts.save(receipt);

    return true;
  });

  const sendReceiptChunk = Effect.fnUntraced(function* (
    receipt: GatewayReceipt,
    adapter: ChatAdapter,
    connection: GatewayConnection,
    generation: number,
  ) {
    const index = receipt.sent.length;

    if (index >= (receipt.chunks?.length ?? 0)) return true;

    const blockedUntil = yield* receipts.cooldown(
      adapter.id,
      receipt.channelId,
    );

    const now = yield* Clock.currentTimeMillis;

    if (
      blockedUntil > now ||
      !connections.holds(adapter.id, connection, generation)
    )
      return false;

    const sent = yield* transport(() =>
      connection.send({
        channelId: receipt.channelId,
        replyTo: receipt.messageId,
        text: receipt.chunks![index]!,
        nonce: `${receiptKey(receipt)}:${index}`,
      }),
    );

    connections.note(adapter.id, null);
    receipt.sent.push(sent);
    yield* receipts.save(receipt);

    return true;
  });

  const typingAt = new Map<string, number>();

  const showTyping = Effect.fnUntraced(function* (
    key: string,
    channelId: string,
    adapter: ChatAdapter,
    connection: GatewayConnection,
  ) {
    const now = yield* Clock.currentTimeMillis;

    if (
      !connection.typing ||
      now - (typingAt.get(key) ?? -Infinity) < adapter.typingRenewalMs
    )
      return;
    typingAt.set(key, now);
    yield* transport(() => connection.typing!(channelId)).pipe(Effect.ignore);
  });

  const processReceipt = Effect.fn("MessageGateway.processReceipt")(function* (
    receipt: GatewayReceipt,
    adapter: ChatAdapter,
    connection: GatewayConnection,
    generation: number,
  ) {
    if (!connections.live(adapter.id, generation)) return;
    const prepared = yield* prepareReceipt(receipt, adapter, generation);

    if (!connections.holds(adapter.id, connection, generation)) return;
    const current = yield* connections.config(adapter.id);

    if (!authorizedMessage(current, receiptMessage(receipt))) return;

    const key = receiptKey(receipt);

    if (!prepared) {
      yield* showTyping(key, receipt.channelId, adapter, connection);

      return;
    }

    typingAt.delete(key);

    if (!(yield* sendReceiptChunk(receipt, adapter, connection, generation)))
      return;

    if (receipt.sent.length < (receipt.chunks?.length ?? 0)) return;

    receipt.state = "done";
    receipt.finishedAt = yield* Clock.currentTimeMillis;
    yield* receipts.save(receipt);
  });

  const expireReceipt = Effect.fnUntraced(function* (
    receipt: GatewayReceipt,
    now: number,
  ) {
    if (
      !(
        receipt.expiresAt <= now || receipt.attemptCount >= MAX_RECEIPT_ATTEMPTS
      )
    )
      return false;
    receipt.state = "failed";
    receipt.failedAt = now;
    yield* receipts.save(receipt);

    connections.note(
      receipt.adapterId,
      "A message expired or exhausted its delivery retries. Send a new message to try again.",
    );

    return true;
  });

  const receiptBlocked = (receipt: GatewayReceipt, now: number) =>
    workers.size >= 4 ||
    (receipt.nextAttemptAt ?? 0) > now ||
    [...workers.values()].some(
      (worker) =>
        worker.adapterId === receipt.adapterId &&
        worker.channelId === receipt.channelId,
    );

  const receiptAuthorized = Effect.fnUntraced(function* (
    receipt: GatewayReceipt,
    adapter: ChatAdapter,
    expected: string | undefined,
    now: number,
  ) {
    const token = yield* connections
      .readToken(adapter)
      .pipe(Effect.orElseSucceed(() => undefined));

    if (token !== expected) return false;
    const current = yield* connections.config(adapter.id);

    if (!authorizedMessage(current, receiptMessage(receipt))) return false;

    return !((yield* receipts.cooldown(adapter.id, receipt.channelId)) > now);
  });

  const receiptConnection = Effect.fnUntraced(function* (
    receipt: GatewayReceipt,
    now: number,
  ) {
    const adapter = adapters.find((entry) => entry.id === receipt.adapterId);

    const current = adapter && connections.current(adapter.id);

    if (!adapter || !current) return null;

    if (!(yield* receiptAuthorized(receipt, adapter, current.token, now)))
      return null;

    const { connection, generation } = current;

    return connections.holds(adapter.id, connection, generation)
      ? { adapter, connection, generation }
      : null;
  });

  const transportFailure = (cause: Cause.Cause<unknown>) => {
    const failure = Cause.findError(cause);

    return Result.isSuccess(failure) &&
      failure.success instanceof GatewayTransportError
      ? failure.success
      : null;
  };

  const failReceipt = Effect.fnUntraced(function* (
    receipt: GatewayReceipt,
    adapter: ChatAdapter,
    cause: Cause.Cause<unknown>,
  ) {
    if (Cause.hasInterruptsOnly(cause)) return;
    const error = transportFailure(cause);
    const failedAt = yield* Clock.currentTimeMillis;
    receipt.attemptCount++;

    const wait = Math.max(
      retryDelay(receipt.attemptCount),
      error?.details.retryAfterMs ?? 0,
    );

    receipt.nextAttemptAt = failedAt + wait;

    if (
      error?.details.permanent ||
      receipt.attemptCount >= MAX_RECEIPT_ATTEMPTS ||
      receipt.expiresAt <= failedAt
    ) {
      receipt.state = "failed";
      receipt.failedAt = failedAt;
      connections.note(
        adapter.id,
        "Message delivery failed permanently. Check destination permissions and send a new message.",
      );
    } else
      connections.note(
        adapter.id,
        "Message submission or delivery failed. Retrying automatically after a delay.",
      );

    if (error?.details.rateLimit) {
      yield* receipts.defer(
        adapter.id,
        error.details.rateLimit.scope === "adapter" ? null : receipt.channelId,
        failedAt + wait,
      );
    }

    yield* receipts.save(receipt);
  });

  const dispatchReceipts = Semaphore.withPermit(
    processing,
    Effect.gen(function* () {
      if (connections.isClosed()) return;
      const now = yield* Clock.currentTimeMillis;

      for (const receipt of yield* receipts.pending) {
        const key = receiptKey(receipt);

        if (workers.has(key)) continue;

        if (yield* expireReceipt(receipt, now)) continue;

        if (receiptBlocked(receipt, now)) continue;
        const target = yield* receiptConnection(receipt, now);

        if (!target) continue;
        const { adapter, connection, generation } = target;

        const worker = processReceipt(
          receipt,
          adapter,
          connection,
          generation,
        ).pipe(
          Effect.catchCause((cause) => failReceipt(receipt, adapter, cause)),
          Effect.ensuring(
            Effect.sync(() => {
              workers.delete(key);
            }),
          ),
        );

        const fiber = yield* worker.pipe(
          Effect.forkIn(scope, { startImmediately: false }),
        );

        workers.set(key, {
          adapterId: receipt.adapterId,
          channelId: receipt.channelId,
          fiber,
        });
      }
    }),
  );

  return { cancelWorkers, dispatch: dispatchReceipts };
});

export type ReceiptDelivery = Effect.Success<
  ReturnType<typeof receiptDelivery>
>;
