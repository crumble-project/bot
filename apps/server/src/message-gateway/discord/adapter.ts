import { createHash } from "node:crypto";
import {
  Client,
  DiscordAPIError,
  GatewayIntentBits,
  HTTPError,
  Partials,
  RateLimitError,
  Routes,
  type ClientOptions,
  type REST,
  type RESTPostAPIChannelMessageJSONBody,
} from "discord.js";
import { z } from "zod";
import {
  GatewayTransportError,
  type ChatAdapter,
  type GatewayConnection,
  type GatewayMessage,
  type GatewayStatus,
} from "../adapter";

export const DISCORD_SECRET_KEY = "discord:token";
const SEND_TIMEOUT_MS = 10_000;
const sentMessageSchema = z.object({ id: z.string().min(1) });

const rateLimitResponseSchema = z.object({
  retry_after: z.number().nonnegative(),
  global: z.boolean().optional(),
});

type DeliveryErrorDetails = ConstructorParameters<
  typeof GatewayTransportError
>[1];

function rateLimitDetails(failure: RateLimitError): DeliveryErrorDetails {
  return {
    permanent: false,
    status: 429,
    retryAfterMs: Math.max(
      0,
      ...[
        failure.retryAfter,
        failure.timeToReset,
        failure.sublimitTimeout,
      ].filter(Number.isFinite),
    ),
    rateLimit: {
      scope:
        failure.global || failure.scope === "global" ? "adapter" : "channel",
    },
  };
}

function isPermanentStatus(status: number | undefined): boolean {
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    ![408, 425, 429].includes(status)
  );
}

function httpErrorDetails(failure: Error): DeliveryErrorDetails {
  const status =
    failure instanceof DiscordAPIError || failure instanceof HTTPError
      ? failure.status
      : undefined;

  const details: DeliveryErrorDetails = {
    permanent: isPermanentStatus(status),
  };

  if (status !== undefined) details.status = status;

  if (status === 429 && failure instanceof DiscordAPIError) {
    const parsed = rateLimitResponseSchema.safeParse(failure.rawError);

    if (parsed.success) {
      details.retryAfterMs = Math.ceil(parsed.data.retry_after * 1_000);
      details.rateLimit = {
        scope: parsed.data.global ? "adapter" : "channel",
      };
    }
  }

  return details;
}

export type DiscordMessage = {
  id: string;
  channelId: string;
  author: { id: string; bot: boolean };
  webhookId: string | null;
  content: string;
  attachments: { size: number };
  reference: { messageId?: string | null } | null;
  inGuild(): boolean;
};

export type DiscordClient = {
  user: { id: string } | null;
  on(event: "messageCreate", listener: (message: DiscordMessage) => void): void;
  on(
    event:
      | "clientReady"
      | "shardReconnecting"
      | "shardResume"
      | "shardDisconnect"
      | "invalidated",
    listener: () => void,
  ): void;
  on(event: "error" | "shardError", listener: (error: Error) => void): void;
  login(token: string): Promise<string>;
  destroy(): Promise<void>;
  removeAllListeners(): void;
  rest: Pick<REST, "post">;
};

export function normalizeDiscordMessage(
  message: DiscordMessage,
  applicationId?: string,
): GatewayMessage | undefined {
  if (message.author.bot || message.webhookId) return undefined;

  const normalized: GatewayMessage = {
    id: message.id,
    channelId: message.channelId,
    senderId: message.author.id,
    text: message.content,
    isDirectMessage: !message.inGuild(),
    hasAttachments: message.attachments.size > 0,
  };

  if (message.reference?.messageId)
    normalized.replyTo = message.reference.messageId;

  if (applicationId) {
    const content = message.content.trimStart();

    const prefix = [`<@${applicationId}>`, `<@!${applicationId}>`].find(
      (mention) =>
        content.startsWith(mention) &&
        (content.length === mention.length ||
          /^\s/.test(content.slice(mention.length))),
    );

    if (prefix)
      normalized.routingText = content.slice(prefix.length).trimStart();
  }

  return normalized;
}

const createClient = (options: ClientOptions): DiscordClient =>
  new Client(options);

export function discordAdapter(
  clientFactory: (options: ClientOptions) => DiscordClient = createClient,
  deadline: (milliseconds: number) => AbortSignal = (milliseconds) =>
    AbortSignal.timeout(milliseconds),
): ChatAdapter {
  const options: ClientOptions = {
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
    rest: {
      rejectOnRateLimit: ["/"],
      retries: 0,
      timeout: SEND_TIMEOUT_MS,
    },
  };

  return {
    id: "discord",
    label: "Discord",
    secretKey: DISCORD_SECRET_KEY,
    maxMessageLength: 2_000,
    async connect(host) {
      const client = clientFactory(options);
      const pending = new Set<AbortController>();
      let closed = false;
      let invalidated = false;

      const errorMessage = (error: Error) => {
        const message = error.message;

        return host.token
          ? message.replaceAll(host.token, "[redacted]")
          : message;
      };

      const status = (value: GatewayStatus, error?: string) => {
        if (!closed) host.onStatus(value, error);
      };

      const reportError = (error: Error) =>
        status("error", errorMessage(error));

      const deliveryError = (failure: Error) => {
        if (failure instanceof RateLimitError)
          return new GatewayTransportError(
            "Discord message delivery rate limited.",
            rateLimitDetails(failure),
          );

        return new GatewayTransportError(
          errorMessage(failure),
          httpErrorDetails(failure),
        );
      };

      client.on("messageCreate", (message) => {
        if (closed) return;
        const normalized = normalizeDiscordMessage(message, client.user?.id);

        if (normalized)
          void host.onMessage(normalized).catch((error) => {
            const failure =
              error instanceof Error ? error : new Error(String(error));

            reportError(failure);
          });
      });
      client.on("clientReady", () => status("connected"));
      client.on("shardResume", () => status("connected"));
      client.on("shardReconnecting", () => status("connecting"));
      client.on("shardDisconnect", () => status("disconnected"));
      client.on("invalidated", () => {
        if (closed || invalidated) return;
        invalidated = true;
        const error = "Discord session invalidated. Reconnect the gateway.";
        status("error", error);
        host.onInvalidated(error);
      });
      client.on("error", reportError);
      client.on("shardError", reportError);

      status("connecting");

      try {
        await client.login(host.token);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));

        reportError(failure);
        closed = true;

        try {
          await client.destroy();
        } catch {
          // Preserve the login failure when cleanup also fails.
        } finally {
          client.removeAllListeners();
        }

        throw new Error(errorMessage(failure));
      }

      const connection: GatewayConnection = {
        async typing(channelId) {
          if (closed) return;
          await client.rest.post(Routes.channelTyping(channelId), {
            signal: deadline(SEND_TIMEOUT_MS),
          });
        },
        async send(input) {
          if (closed) throw new Error("Discord connection is closed.");
          const controller = new AbortController();

          const signal = AbortSignal.any([
            controller.signal,
            deadline(SEND_TIMEOUT_MS),
          ]);

          pending.add(controller);

          try {
            const body: RESTPostAPIChannelMessageJSONBody = {
              content: input.text,
              allowed_mentions: { parse: [], replied_user: false },
              nonce: createHash("sha256")
                .update(input.nonce)
                .digest("hex")
                .slice(0, 24),
              enforce_nonce: true,
            };

            if (input.replyTo)
              body.message_reference = {
                message_id: input.replyTo,
                fail_if_not_exists: false,
              };

            const response = await client.rest.post(
              Routes.channelMessages(input.channelId),
              { body, signal },
            );

            const parsed = sentMessageSchema.safeParse(response);

            if (!parsed.success)
              throw new Error("Discord returned an invalid message response.");

            return parsed.data.id;
          } catch (error) {
            if (signal.aborted)
              throw new Error(
                closed
                  ? "Discord connection is closed."
                  : "Discord message delivery timed out.",
              );

            const failure =
              error instanceof Error ? error : new Error(String(error));

            throw deliveryError(failure);
          } finally {
            pending.delete(controller);
          }
        },
        async close() {
          if (closed) return;
          closed = true;

          for (const controller of pending) controller.abort();
          pending.clear();

          try {
            await client.destroy();
          } finally {
            client.removeAllListeners();
            host.onStatus("disconnected");
          }
        },
      };

      return connection;
    },
  };
}
