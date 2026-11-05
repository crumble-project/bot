import type { ConnectionStatus } from "../shared/domain";

export type GatewayMessage = {
  id: string;
  channelId: string;
  senderId: string;
  text: string;
  routingText?: string;
  isDirectMessage: boolean;
  replyTo?: string;
  hasAttachments?: boolean;
};

export type GatewayConnection = {
  send(input: {
    channelId: string;
    replyTo?: string;
    text: string;
    /** The same for every retry of one chunk; the adapter fits it to its platform's format. */
    nonce: string;
  }): Promise<string>;
  /** Shows that a bot is writing in the channel, for a few seconds; best effort. */
  typing?(channelId: string): Promise<void>;
  close(): Promise<void>;
};

export type ChatAdapter = {
  id: string;
  label: string;
  secretKey: string;
  maxMessageLength: number;
  /** How often to repeat `typing` while a bot works. */
  typingRenewalMs: number;
  connect(host: {
    token: string;
    onMessage(message: GatewayMessage): Promise<void>;
    onInvalidated(): void;
    onStatus(status: ConnectionStatus): void;
  }): Promise<GatewayConnection>;
};

export class GatewayTransportError extends Error {
  constructor(
    message: string,
    readonly details: {
      permanent: boolean;
      retryAfterMs?: number;
      rateLimit?: {
        scope: "adapter" | "channel";
      };
    },
  ) {
    super(message);
    this.name = "GatewayTransportError";
  }
}
