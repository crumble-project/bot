import { Schema } from "effect";

// SAFETY: Bun's WebSocket takes connection options where lib.dom's constructor only declares protocols, so it is
// called reflectively and the result decoded as a WebSocket before it is handed out.
export const openWebSocket = (
  url: string,
  options?: Bun.WebSocketOptions,
): WebSocket => {
  const socket: unknown = Reflect.construct(WebSocket, [url, options]);

  return Schema.decodeUnknownSync(Schema.instanceOf(WebSocket))(socket);
};
