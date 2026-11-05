import { Effect } from "effect";
import type { ConnectionStatus } from "./domain";

/** Doubles from `baseMs` with each attempt, up to 15 minutes. */
export const backoff = (baseMs: number, attempt: number) =>
  Math.min(baseMs * 2 ** Math.min(attempt - 1, 20), 900_000);

const reconnectDelay = (attempt: number) => backoff(60_000, attempt);

/** What a kept-open connection reports and when it may try again. Each owner keeps its transport. */
export type Reconnecting = {
  status: ConnectionStatus;
  error: string | null;
  failures: number;
  retryAt: number;
};

export const disconnected = (): Reconnecting => ({
  status: "disconnected",
  error: null,
  failures: 0,
  retryAt: 0,
});

/** Records one more failure; the next attempt waits at least `atLeastMs`. */
export const connectionFailed = (
  state: Reconnecting,
  now: number,
  error: string,
  atLeastMs = 0,
) => {
  state.failures++;
  state.retryAt = now + Math.max(reconnectDelay(state.failures), atLeastMs);
  state.status = "error";
  state.error = error;
};

/** New credentials owe nothing to the old ones' failures. */
export const credentialsChanged = (state: Reconnecting) => {
  state.failures = 0;
  state.retryAt = 0;
};

/** The token, or why it could not be read, which explains more than a missing-token error. */
export const tokenOrFailure = <R>(
  read: Effect.Effect<string | undefined, { message: string }, R>,
) =>
  read.pipe(
    Effect.match({
      onFailure: (failure) => ({
        token: undefined,
        failure: failure.message,
      }),
      onSuccess: (token) => ({ token, failure: undefined }),
    }),
  );
