import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";

/** Runs once the stream ends, in the order it was registered. */
export type StreamCleanup = () => void | Promise<void>;

export type StreamSetup = {
  stream: SSEStreamingApi;
  /** Ends the stream early, for a failure a write cannot report. */
  close: () => void;
  /** Undoes what the setup subscribed or started, when the client leaves or the setup throws. */
  onClose: (cleanup: StreamCleanup) => void;
};

/** Browsers show a response only once a body chunk arrives. */
export const sendHeartbeat = (stream: SSEStreamingApi) =>
  stream.writeSSE({ event: "heartbeat", data: "{}" });

/** Sends the current snapshot, unless the client is already gone. */
export const snapshotSender =
  <T>(stream: SSEStreamingApi, snapshot: () => Promise<T>) =>
  async () => {
    if (!stream.aborted)
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify(await snapshot()),
      });
  };

/**
 * An SSE endpoint that ends when the client leaves, with a heartbeat so an idle stream stays open. A setup that
 * throws has its cleanups run before the error reaches the app's error handler.
 */
export const streamEvents = (
  c: Context,
  setup: (options: StreamSetup) => Promise<void>,
) =>
  streamSSE(c, async (stream) => {
    let finish!: () => void;

    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    stream.onAbort(finish);

    const cleanups: StreamCleanup[] = [];

    const clean = async () => {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    };

    try {
      await setup({ stream, close: finish, onClose: (c) => cleanups.push(c) });
    } catch (error) {
      await clean();
      throw error;
    }

    // Started only once setup succeeded: a failed setup has no stream left to keep open.
    const heartbeat = setInterval(() => {
      sendHeartbeat(stream).catch(finish);
    }, 15000);

    try {
      await finished;
    } finally {
      clearInterval(heartbeat);
      await clean();
    }
  });
