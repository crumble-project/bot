type BunWebSocketConstructor = typeof WebSocket &
  (new (url: string, options?: Bun.WebSocketOptions) => WebSocket);

// SAFETY: lib.dom's WebSocket type hides Bun's constructor options; Bun's WebSocket accepts `headers`.
const BunWebSocket = WebSocket as BunWebSocketConstructor;

export const openWebSocket = (
  url: string,
  options?: Bun.WebSocketOptions,
): WebSocket => new BunWebSocket(url, options);
