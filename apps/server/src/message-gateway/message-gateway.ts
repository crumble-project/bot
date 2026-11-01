import type { JsonValue } from "@earendil-works/chord";
import { createHash } from "node:crypto";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Fiber,
  Layer,
  Result,
  Semaphore,
} from "effect";
import { AgentRepository } from "../bots/agent-repository";
import { Bots } from "../bots/bots";
import { ExecutionRepository } from "../bots/execution-repository";
import { BotRuntime } from "../bots/runtime";
import {
  defaultGatewayConfig,
  gatewayConfigInput,
  type GatewayConfig,
  type GatewayDescription,
} from "../contract/message-gateway";
import { SecretRepository } from "../credentials/secret-repository";
import { keyedSecretReader } from "../password-managers/secret-references";
import { SecretValues } from "../password-managers/secret-values";
import { Plugins, pluginChatAdapters } from "../plugins/plugins";
import type { Agent } from "../shared/domain";
import { InvalidInput, NotFound, type AppError } from "../shared/errors";
import { SettingsRepository } from "../shared/settings-repository";
import { startTicking } from "../shared/ticker";
import {
  GatewayTransportError,
  type ChatAdapter,
  type GatewayConnection,
  type GatewayMessage,
  type GatewayStatus,
} from "./adapter";
import { GatewayRepository, type GatewayReceipt } from "./gateway-repository";
import { authorizedMessage, gatewayChunks, selectGatewayBot } from "./routing";

const configKey = (id: string) => `message-gateway:${id}`;

const transport = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      cause instanceof GatewayTransportError
        ? cause
        : new GatewayTransportError("Gateway transport failed", {
            permanent: false,
          }),
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError((cause) =>
      cause instanceof GatewayTransportError
        ? cause
        : new GatewayTransportError("Gateway transport timed out", {
            permanent: false,
          }),
    ),
  );

const decodeConfig = (input: JsonValue | GatewayConfig) =>
  Effect.suspend(() => {
    const result = gatewayConfigInput.safeParse(input);

    return result.success
      ? Effect.succeed(result.data)
      : Effect.fail(
          new InvalidInput({
            message:
              "Invalid message gateway configuration. Configure a single owner user ID and save again.",
          }),
        );
  });

export const reconnectDelay = (attempt: number) =>
  Math.min(60000 * 2 ** Math.min(attempt - 1, 20), 900000);

const retryDelay = (attempt: number) =>
  Math.min(5000 * 2 ** Math.min(attempt - 1, 20), 900000);

type ConnectionState = {
  connection?: GatewayConnection | undefined;
  token?: string | undefined;
  status: GatewayStatus;
  error: string | null;
  generation: number;
  retryAt: number;
  failures: number;
  connectedAt: number | null;
  invalidated: boolean;
};

export class MessageGateway extends Context.Service<
  MessageGateway,
  {
    readonly list: Effect.Effect<GatewayDescription[]>;
    readonly update: (
      id: string,
      config: GatewayConfig,
    ) => Effect.Effect<GatewayDescription, AppError>;
    readonly receive: (
      adapterId: string,
      message: GatewayMessage,
    ) => Effect.Effect<void, AppError>;
    readonly tick: Effect.Effect<void>;
    readonly start: Effect.Effect<void>;
  }
>()("crumble/message-gateway/MessageGateway") {
  static readonly layer = Layer.effect(
    MessageGateway,
    Effect.gen(function* () {
      const adapters = pluginChatAdapters(yield* Plugins);

      if (
        new Set(adapters.map((adapter) => adapter.id)).size !== adapters.length
      )
        return yield* new InvalidInput({
          message: "Message gateway adapter IDs must be unique",
        });

      for (const adapter of adapters)
        if (
          !Number.isInteger(adapter.maxMessageLength) ||
          adapter.maxMessageLength < 2
        )
          return yield* new InvalidInput({
            message: `Invalid message limit for ${adapter.id}`,
          });
      const settings = yield* SettingsRepository;
      const secrets = yield* SecretRepository;
      const agents = yield* AgentRepository;
      const bots = yield* Bots;
      const runtime = yield* BotRuntime;
      const executions = yield* ExecutionRepository;
      const receipts = yield* GatewayRepository;

      const states = new Map<string, ConnectionState>(
        adapters.map((adapter) => [
          adapter.id,
          {
            status: "disconnected",
            error: null,
            generation: 0,
            retryAt: 0,
            failures: 0,
            connectedAt: null,
            invalidated: false,
          },
        ]),
      );

      let closed = false;
      const scope = yield* Effect.scope;
      const processing = Semaphore.makeUnsafe(1);
      const run = Effect.runPromiseWith(yield* Effect.context());

      const workers = new Map<
        string,
        { adapterId: string; channelId: string; fiber: Fiber.Fiber<void> }
      >();

      const reconciling = new Set<string>();
      const reconfiguring = new Set<string>();
      const configurationChanges = Semaphore.makeUnsafe(1);
      let pruneAt = 0;

      const cancelWorkers = Effect.fnUntraced(function* (adapterId: string) {
        for (const worker of workers.values())
          if (worker.adapterId === adapterId)
            yield* Fiber.interrupt(worker.fiber);
      });

      const config = Effect.fnUntraced(function* (id: string) {
        const stored = yield* settings.get(configKey(id));

        return yield* decodeConfig(stored ?? defaultGatewayConfig()).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              states.get(id)!.error = error.message;

              return defaultGatewayConfig();
            }),
          ),
        );
      });

      const selectRecipient = Effect.fnUntraced(function* (
        adapterId: string,
        current: GatewayConfig,
        message: GatewayMessage,
      ) {
        let botId: string | null = null;
        let response: string[] | null = null;

        if (message.hasAttachments)
          response = [
            "Attachments are not supported by this gateway. Send a text-only message.",
          ];
        else if (!(message.routingText ?? message.text).trim())
          response = ["Send a text message for a bot to answer."];
        else if (message.text.length > 32000)
          response = [
            "This message is too long. Send at most 32000 characters.",
          ];
        else {
          const replyBot = message.replyTo
            ? yield* receipts.replyBot(
                adapterId,
                message.channelId,
                message.replyTo,
              )
            : null;

          const available = yield* agents.list;

          const selected = yield* Effect.try({
            try: () =>
              selectGatewayBot(
                current,
                message.routingText ?? message.text,
                available,
                replyBot,
              ),
            catch: (cause) =>
              new InvalidInput({
                message:
                  cause instanceof Error ? cause.message : "Unknown recipient",
              }),
          }).pipe(Effect.result);

          if (Result.isSuccess(selected)) botId = selected.success.id;
          else response = [selected.failure.message];
        }

        return { botId, response };
      });

      const receive = Effect.fn("MessageGateway.receive")(function* (
        adapterId: string,
        message: GatewayMessage,
      ) {
        const adapter = adapters.find((entry) => entry.id === adapterId);

        if (!adapter || closed) return;
        const current = yield* config(adapterId);

        if (!authorizedMessage(current, message)) return;

        const { botId, response } = yield* selectRecipient(
          adapterId,
          current,
          message,
        );

        const receivedAt = yield* Clock.currentTimeMillis;
        yield* receipts.insert({
          adapterId,
          messageId: message.id,
          channelId: message.channelId,
          senderId: message.senderId,
          isDirectMessage: message.isDirectMessage,
          botId,
          requestId: `gateway:${adapterId}:${crypto.randomUUID()}`,
          text: message.text,
          executionId: null,
          chunks:
            response?.flatMap((text) =>
              gatewayChunks(text, adapter.maxMessageLength),
            ) ?? null,
          sent: [],
          state: "pending",
          createdAt: receivedAt,
          expiresAt: receivedAt + 86400000,
        });
      });

      const stop = Effect.fnUntraced(function* (state: ConnectionState) {
        state.generation++;
        const connection = state.connection;
        state.connection = undefined;
        state.connectedAt = null;
        state.invalidated = false;
        state.status = "disconnected";

        if (connection) {
          const closing = transport(() => connection.close()).pipe(
            Effect.catch(() => Effect.void),
          );

          yield* closing;
        }
      });

      const readSecret = keyedSecretReader(secrets, yield* SecretValues);
      const readToken = (adapter: ChatAdapter) => readSecret(adapter.secretKey);

      // A password manager that can't read the token explains itself instead of the generic missing-token error.
      const tokenOrError = (adapter: ChatAdapter) =>
        readToken(adapter).pipe(
          Effect.match({
            onFailure: (failure) => ({
              token: undefined,
              error: failure.message,
            }),
            onSuccess: (token) => ({ token, error: undefined }),
          }),
        );

      const configureConnection = Effect.fnUntraced(function* (
        adapter: ChatAdapter,
        state: ConnectionState,
        current: GatewayConfig,
        token: string | undefined,
        tokenError?: string,
      ) {
        if (!current.enabled || !token) {
          yield* cancelWorkers(adapter.id);

          if (state.connection || state.token) yield* stop(state);
          state.token = undefined;
          state.status = current.enabled ? "error" : "disconnected";

          if (current.enabled)
            state.error =
              tokenError ?? "Configure the adapter token in plugin settings.";

          return false;
        }

        if (state.token !== token) {
          yield* cancelWorkers(adapter.id);
          yield* stop(state);
          state.token = token;
          state.failures = 0;
          state.retryAt = 0;
        }

        return true;
      });

      const invalidateConnection = Effect.fnUntraced(function* (
        adapter: ChatAdapter,
        state: ConnectionState,
        now: number,
      ) {
        yield* cancelWorkers(adapter.id);
        yield* stop(state);
        state.failures++;
        state.retryAt = now + reconnectDelay(state.failures);
        state.status = "error";
        state.error =
          "The adapter connection was invalidated. Reconnecting automatically.";
      });

      const connectAdapter = Effect.fnUntraced(function* (
        adapter: ChatAdapter,
        state: ConnectionState,
        token: string,
        generation: number,
      ) {
        return yield* transport(() =>
          adapter
            .connect({
              token,
              onMessage: (message) =>
                closed || state.generation !== generation
                  ? Promise.resolve()
                  : run(
                      receive(adapter.id, message).pipe(
                        Effect.catchCause(() =>
                          Effect.sync(() => {
                            state.error =
                              "Incoming message persistence failed. Check server storage and resend the message.";
                          }),
                        ),
                        Effect.forkIn(scope),
                        Effect.flatMap(Fiber.join),
                      ),
                    ),
              onStatus: (status, error) => {
                if (closed || state.generation !== generation) return;
                state.status = status;
                state.error = error
                  ? "The adapter reported an error. Check its token, intents, and permissions."
                  : null;
              },
              onInvalidated: () => {
                if (closed || state.generation !== generation) return;
                state.invalidated = true;
              },
            })
            .then(async (connection) => {
              if (closed || state.generation !== generation) {
                await connection.close();

                return undefined;
              }

              return connection;
            }),
        ).pipe(Effect.result);
      });

      const readyToConnect = Effect.fnUntraced(function* (
        adapter: ChatAdapter,
        state: ConnectionState,
        now: number,
      ) {
        if (state.invalidated) {
          yield* invalidateConnection(adapter, state, now);

          return false;
        }

        if (state.connection) {
          if (state.connectedAt !== null && now - state.connectedAt >= 300000)
            state.failures = 0;

          return false;
        }

        return !(state.retryAt > now);
      });

      const reconcile = Effect.fnUntraced(function* (adapter: ChatAdapter) {
        if (reconfiguring.has(adapter.id)) return;
        const state = states.get(adapter.id)!;
        const current = yield* config(adapter.id);
        const { token, error } = yield* tokenOrError(adapter);
        const now = yield* Clock.currentTimeMillis;

        if (
          !(yield* configureConnection(adapter, state, current, token, error))
        )
          return;

        if (!(yield* readyToConnect(adapter, state, now))) return;
        const generation = ++state.generation;
        state.status = "connecting";
        state.error = null;

        const connected = yield* connectAdapter(
          adapter,
          state,
          token!,
          generation,
        );

        if (!generationCurrent(adapter.id, generation)) return;

        if (Result.isSuccess(connected)) {
          state.connection = connected.success;
          state.connectedAt = now;

          if (state.connection && state.status === "connecting")
            state.status = "connected";
          yield* dispatchReceipts;
        } else {
          state.generation++;
          state.failures++;
          state.status = "error";
          state.error =
            "Gateway login failed. Check its token, intents, and connection; reconnecting automatically.";
          state.retryAt =
            now +
            Math.max(
              reconnectDelay(state.failures),
              connected.failure.details.retryAfterMs ?? 0,
            );
        }
      });

      const generationCurrent = (adapterId: string, generation: number) =>
        !closed && states.get(adapterId)!.generation === generation;

      const receiptExecution = Effect.fnUntraced(function* (
        receipt: GatewayReceipt,
        botId: string,
        generation: number,
      ) {
        let execution = receipt.executionId
          ? yield* executions.get(receipt.executionId)
          : null;

        if (!execution)
          execution =
            (yield* executions.list(botId)).find(
              (entry) => entry.requestId === receipt.requestId,
            ) ?? null;

        if (execution) return execution;

        if (!generationCurrent(receipt.adapterId, generation)) return null;
        execution = yield* bots.sendChat(
          botId,
          receipt.text,
          receipt.requestId,
        );
        receipt.executionId = execution.id;
        yield* receipts.save(receipt);

        return execution;
      });

      const botResponse = Effect.fnUntraced(function* (
        receipt: GatewayReceipt,
        adapter: ChatAdapter,
        agent: Agent,
        generation: number,
      ) {
        const execution = yield* receiptExecution(
          receipt,
          receipt.botId!,
          generation,
        );

        if (!execution) return null;

        if (execution.status === "pending" || execution.status === "running")
          return null;

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

        return gatewayChunks(
          response.join("\n\n") || "The bot completed without a text response.",
          adapter.maxMessageLength,
        );
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
            : yield* botResponse(receipt, adapter, agent, generation);

        if (chunks === null) return false;
        receipt.chunks = chunks.flatMap((text) =>
          gatewayChunks(text, adapter.maxMessageLength),
        );
        yield* receipts.save(receipt);

        return true;
      });

      const connectionMatches = (
        state: ConnectionState,
        connection: GatewayConnection,
        generation: number,
      ) => state.generation === generation && state.connection === connection;

      const connectionCurrent = (
        state: ConnectionState,
        connection: GatewayConnection,
        generation: number,
      ) => !closed && connectionMatches(state, connection, generation);

      const sendReceiptChunk = Effect.fnUntraced(function* (
        receipt: GatewayReceipt,
        adapter: ChatAdapter,
        connection: GatewayConnection,
        generation: number,
      ) {
        const state = states.get(adapter.id)!;
        const index = receipt.sent.length;

        if (index >= (receipt.chunks?.length ?? 0)) return true;

        const blockedUntil = yield* receipts.cooldown(
          adapter.id,
          receipt.channelId,
        );

        const now = yield* Clock.currentTimeMillis;

        if (
          blockedUntil > now ||
          !connectionCurrent(state, connection, generation) ||
          reconfiguring.has(adapter.id)
        )
          return false;

        const nonce = createHash("sha256")
          .update(`${receipt.adapterId}:${receipt.messageId}:${index}`)
          .digest("hex")
          .slice(0, 24);

        const sent = yield* transport(() =>
          connection.send({
            channelId: receipt.channelId,
            replyTo: receipt.messageId,
            text: receipt.chunks![index]!,
            nonce,
          }),
        );

        state.error = null;
        receipt.sent.push(sent);
        yield* receipts.save(receipt);

        return true;
      });

      // Discord's indicator lasts 10 seconds; renewing at 8 keeps it steady while the bot works.
      const typingAt = new Map<string, number>();

      const showTyping = Effect.fnUntraced(function* (
        key: string,
        channelId: string,
        connection: GatewayConnection,
      ) {
        const now = yield* Clock.currentTimeMillis;

        if (!connection.typing || now - (typingAt.get(key) ?? -Infinity) < 8000)
          return;
        typingAt.set(key, now);
        yield* transport(() => connection.typing!(channelId)).pipe(
          Effect.ignore,
        );
      });

      const processReceipt = Effect.fn("MessageGateway.processReceipt")(
        function* (
          receipt: GatewayReceipt,
          adapter: ChatAdapter,
          connection: GatewayConnection,
          generation: number,
        ) {
          if (!generationCurrent(adapter.id, generation)) return;
          const prepared = yield* prepareReceipt(receipt, adapter, generation);
          const state = states.get(adapter.id)!;

          if (!connectionCurrent(state, connection, generation)) return;
          const current = yield* config(adapter.id);

          if (
            !authorizedMessage(current, {
              id: receipt.messageId,
              channelId: receipt.channelId,
              senderId: receipt.senderId,
              text: receipt.text,
              isDirectMessage: receipt.isDirectMessage,
            })
          )
            return;

          const key = `${receipt.adapterId}:${receipt.messageId}`;

          if (!prepared) {
            yield* showTyping(key, receipt.channelId, connection);

            return;
          }

          typingAt.delete(key);

          if (
            !(yield* sendReceiptChunk(receipt, adapter, connection, generation))
          )
            return;

          if (receipt.sent.length < (receipt.chunks?.length ?? 0)) return;

          receipt.state = "done";
          receipt.finishedAt = yield* Clock.currentTimeMillis;
          yield* receipts.save(receipt);
        },
      );

      const expireReceipt = Effect.fnUntraced(function* (
        receipt: GatewayReceipt,
        state: ConnectionState | undefined,
        now: number,
      ) {
        if (!(receipt.expiresAt <= now || receipt.attemptCount >= 10))
          return false;
        receipt.state = "failed";
        receipt.failedAt = now;
        yield* receipts.save(receipt);

        if (state)
          state.error =
            "A message expired or exhausted its delivery retries. Send a new message to try again.";

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
        state: ConnectionState,
        now: number,
      ) {
        const token = yield* readToken(adapter).pipe(
          Effect.orElseSucceed(() => undefined),
        );

        if (token !== state.token) return false;
        const current = yield* config(adapter.id);

        if (
          !authorizedMessage(current, {
            id: receipt.messageId,
            channelId: receipt.channelId,
            senderId: receipt.senderId,
            text: receipt.text,
            isDirectMessage: receipt.isDirectMessage,
          })
        )
          return false;

        return !(
          (yield* receipts.cooldown(adapter.id, receipt.channelId)) > now
        );
      });

      const receiptConnection = Effect.fnUntraced(function* (
        receipt: GatewayReceipt,
        state: ConnectionState | undefined,
        now: number,
      ) {
        const adapter = adapters.find(
          (entry) => entry.id === receipt.adapterId,
        );

        if (
          !adapter ||
          !state?.connection ||
          state.invalidated ||
          reconfiguring.has(adapter.id)
        )
          return null;
        const generation = state.generation;
        const connection = state.connection;

        if (!(yield* receiptAuthorized(receipt, adapter, state, now)))
          return null;

        if (
          !connectionMatches(state, connection, generation) ||
          reconfiguring.has(adapter.id)
        )
          return null;

        return { adapter, connection, generation, state };
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
        state: ConnectionState,
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
          receipt.attemptCount >= 10 ||
          receipt.expiresAt <= failedAt
        ) {
          receipt.state = "failed";
          receipt.failedAt = failedAt;
          state.error =
            "Message delivery failed permanently. Check destination permissions and send a new message.";
        } else
          state.error =
            "Message submission or delivery failed. Retrying automatically after a delay.";

        if (error?.details.rateLimit) {
          yield* receipts.defer(
            adapter.id,
            error.details.rateLimit.scope === "adapter"
              ? null
              : receipt.channelId,
            failedAt + wait,
          );
        }

        yield* receipts.save(receipt);
      });

      const dispatchReceipts = Semaphore.withPermit(
        processing,
        Effect.gen(function* () {
          if (closed) return;
          const now = yield* Clock.currentTimeMillis;

          for (const receipt of yield* receipts.pending) {
            const key = `${receipt.adapterId}:${receipt.messageId}`;
            const state = states.get(receipt.adapterId);

            if (workers.has(key)) continue;

            if (yield* expireReceipt(receipt, state, now)) continue;

            if (receiptBlocked(receipt, now)) continue;
            const target = yield* receiptConnection(receipt, state, now);

            if (!target) continue;
            const { adapter, connection, generation } = target;

            const worker = processReceipt(
              receipt,
              adapter,
              connection,
              generation,
            ).pipe(
              Effect.catchCause((cause) =>
                failReceipt(receipt, adapter, target.state, cause),
              ),
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

      const tick = Effect.gen(function* () {
        if (closed) return;
        const now = yield* Clock.currentTimeMillis;

        if (now >= pruneAt) {
          yield* receipts.pruneGatewayHistory(now);
          pruneAt = now + 3600000;
        }

        for (const adapter of adapters) {
          if (reconciling.has(adapter.id)) continue;
          reconciling.add(adapter.id);
          yield* reconcile(adapter).pipe(
            Effect.catchCause(() =>
              Effect.sync(() => {
                states.get(adapter.id)!.error =
                  "Gateway configuration could not be loaded. Check server storage.";
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                reconciling.delete(adapter.id);
              }),
            ),
            Effect.forkIn(scope),
          );
        }

        yield* dispatchReceipts;
      });

      const list = Effect.gen(function* () {
        const pending = yield* receipts.pending;
        const keys = yield* secrets.listKeys;

        return yield* Effect.forEach(
          adapters,
          Effect.fnUntraced(function* (adapter) {
            const state = states.get(adapter.id)!;

            return {
              id: adapter.id,
              label: adapter.label,
              secretKey: adapter.secretKey,
              tokenConfigured: keys.includes(adapter.secretKey),
              config: yield* config(adapter.id),
              status: state.status,
              error: state.error,
              failedCount: yield* receipts.failedCount(adapter.id),
              pendingCount: pending.filter(
                (receipt) => receipt.adapterId === adapter.id,
              ).length,
            };
          }),
        );
      });

      const update = Effect.fn("MessageGateway.update")(function* (
        id: string,
        input: GatewayConfig,
      ) {
        if (!states.has(id))
          return yield* new NotFound({
            message: "Message gateway not installed",
          });
        const current = yield* decodeConfig(input);

        for (const botId of current.enabled
          ? [
              current.defaultBotId,
              ...current.aliases.map((alias) => alias.botId),
            ]
          : [])
          if (botId && !(yield* agents.get(botId)))
            return yield* new InvalidInput({ message: `Unknown bot ${botId}` });
        yield* Semaphore.withPermit(
          configurationChanges,
          Effect.gen(function* () {
            reconfiguring.add(id);
            const state = states.get(id)!;
            yield* stop(state);
            yield* cancelWorkers(id);
            yield* settings.set(configKey(id), current);
            state.error = null;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                reconfiguring.delete(id);
              }),
            ),
          ),
        );

        return (yield* list).find((description) => description.id === id)!;
      });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;

          for (const state of states.values()) yield* stop(state);
        }),
      );

      const start = startTicking(tick, scope);

      return MessageGateway.of({ list, update, receive, tick, start });
    }),
  );
}
