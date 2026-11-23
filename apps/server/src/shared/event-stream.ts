import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";

export type StreamCleanup = () => void | Promise<void>;

export type StreamSetup = {
  stream: SSEStreamingApi;
  close: () => void;
  onClose: (cleanup: StreamCleanup) => void;
};

const sendHeartbeat = (stream: SSEStreamingApi) =>
  stream.writeSSE({ event: "heartbeat", data: "{}" });

export const snapshotSender =
  <T>(stream: SSEStreamingApi, snapshot: () => Promise<T>) =>
  async () => {
    if (!stream.aborted) {
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify(await snapshot()),
      });
    }
  };

export const streamEvents = (
  c: Context,
  setup: (options: StreamSetup) => Promise<void>,
) =>
  streamSSE(c, async (stream) => {
    let closed = false;
    let wrote = false;
    let finish!: () => void;

    const finished = new Promise<void>((resolve) => {
      finish = () => {
        closed = true;
        resolve();
      };
    });

    stream.onAbort(finish);

    const writeSSE = stream.writeSSE.bind(stream);

    stream.writeSSE = (message) => {
      wrote = true;

      return writeSSE(message);
    };

    const cleanups: Array<StreamCleanup> = [];

    const clean = async () => {
      for (const cleanup of cleanups.splice(0)) {
        await cleanup();
      }
    };

    try {
      await setup({ stream, close: finish, onClose: (c) => cleanups.push(c) });

      if (!wrote && !closed && !stream.aborted) {
        await sendHeartbeat(stream);
      }
    } catch (error) {
      await clean();
      throw error;
    }

    const heartbeat = setInterval(() => {
      sendHeartbeat(stream).catch(finish);
    }, 15_000);

    try {
      await finished;
    } finally {
      clearInterval(heartbeat);
      await clean();
    }
  });
