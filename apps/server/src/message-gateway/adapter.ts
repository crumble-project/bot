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

export type GatewayStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type GatewayConnection = {
  send(input: {
    channelId: string;
    replyTo?: string;
    text: string;
    nonce: string;
  }): Promise<string>;
  close(): Promise<void>;
};

export type ChatAdapter = {
  id: string;
  label: string;
  secretKey: string;
  maxMessageLength: number;
  connect(host: {
    token: string;
    onMessage(message: GatewayMessage): Promise<void>;
    onInvalidated(error?: string): void;
    onStatus(status: GatewayStatus, error?: string): void;
  }): Promise<GatewayConnection>;
};

export class GatewayTransportError extends Error {
  constructor(
    message: string,
    readonly details: {
      permanent: boolean;
      retryAfterMs?: number;
      status?: number;
      rateLimit?: {
        scope: "adapter" | "channel";
      };
    },
  ) {
    super(message);
    this.name = "GatewayTransportError";
  }
}
