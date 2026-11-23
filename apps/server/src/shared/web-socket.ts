import { Schema } from "effect";

export const openWebSocket = (
  url: string,
  options?: Bun.WebSocketOptions,
): WebSocket => {
  const socket: unknown = Reflect.construct(WebSocket, [url, options]);

  return Schema.decodeUnknownSync(Schema.instanceOf(WebSocket))(socket);
};
