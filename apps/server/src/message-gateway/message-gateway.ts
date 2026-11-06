import { gatewayRequest } from "../shared/request-ids";
import { Clock, Context, Effect, Layer, Result } from "effect";
import { AgentRepository } from "../bot-store/agent-repository";
import type {
  GatewayConfig,
  GatewayDescription,
} from "../contract/message-gateway";
import { Secrets } from "../secrets/secrets";
import { Plugins, pluginChatAdapters } from "../plugins/plugins";
import {
  InvalidInput,
  NotFound,
  type AppError,
  errorText,
} from "../shared/errors";
import { SettingsRepository } from "../shared/settings-repository";
import { pruneHourly, startTicking } from "../shared/ticker";
import type { GatewayMessage } from "./adapter";
import { decodeConfig, gatewayConnections } from "./gateway-connections";
import { receiptDelivery, type ReceiptDelivery } from "./gateway-delivery";
import {
  GATEWAY_RECEIPT_TTL_MS,
  GatewayRepository,
} from "./gateway-repository";
import { authorizedMessage, gatewayChunks, selectGatewayBot } from "./routing";
import { MAX_MESSAGE_CHARS } from "../shared/limits";

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
      const secrets = yield* Secrets;
      const agents = yield* AgentRepository;
      const receipts = yield* GatewayRepository;
      const scope = yield* Effect.scope;

      const prune = pruneHourly(
        Effect.flatMap(Clock.currentTimeMillis, receipts.pruneGatewayHistory),
      );

      const connections = yield* gatewayConnections(adapters, {
        receive: (adapterId, message) => receive(adapterId, message),
        cancelWorkers: (adapterId) => delivery.cancelWorkers(adapterId),
        connected: Effect.suspend(() => delivery.dispatch),
      });

      const delivery: ReceiptDelivery = yield* receiptDelivery(
        adapters,
        connections,
      );

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
        else if (message.text.length > MAX_MESSAGE_CHARS)
          response = [
            `This message is too long. Send at most ${MAX_MESSAGE_CHARS} characters.`,
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
                message: errorText(cause, "Unknown recipient"),
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
      ): Effect.fn.Return<void, AppError> {
        const adapter = adapters.find((entry) => entry.id === adapterId);

        if (!adapter || connections.isClosed()) return;
        const current = yield* connections.config(adapterId);

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
          requestId: gatewayRequest(adapterId, crypto.randomUUID()),
          text: message.text,
          executionId: null,
          chunks:
            response?.flatMap((text) =>
              gatewayChunks(text, adapter.maxMessageLength),
            ) ?? null,
          sent: [],
          state: "pending",
          createdAt: receivedAt,
          expiresAt: receivedAt + GATEWAY_RECEIPT_TTL_MS,
        });
      });

      const tick = Effect.gen(function* () {
        if (connections.isClosed()) return;
        yield* prune;
        yield* connections.reconcileAll;
        yield* delivery.dispatch;
      });

      const list = Effect.gen(function* () {
        const pending = yield* receipts.pending;

        return yield* Effect.forEach(
          adapters,
          Effect.fnUntraced(function* (adapter) {
            return {
              id: adapter.id,
              label: adapter.label,
              secretKey: adapter.secretKey,
              tokenConfigured: (yield* secrets.status(adapter.secretKey))
                .configured,
              config: yield* connections.config(adapter.id),
              ...connections.status(adapter.id),
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
        if (!connections.installed(id))
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

        yield* connections.reconfigure(
          id,
          settings.set(`message-gateway:${id}`, current),
        );

        return (yield* list).find((description) => description.id === id)!;
      });

      const start = startTicking(tick, scope);

      return MessageGateway.of({ list, update, receive, tick, start });
    }),
  );
}
