import { Effect } from "effect";
import type { ConnectionStatus } from "./domain";

/** Doubles from `baseMs` with each attempt, up to 15 minutes. */
export const backoff = (baseMs: number, attempt: number) =>
  Math.min(baseMs * 2 ** Math.min(attempt - 1, 20), 900_000);

const reconnectDelay = (attempt: number) => backoff(60_000, attempt);

// A connection that held this long has earned a clean slate; a shorter one still counts as flapping.
const STABLE_CONNECTION_MS = 5 * 60 * 1000;

/** What a kept-open connection reports and when it may try again. Each owner keeps its transport. */
export type Reconnecting = {
  status: ConnectionStatus;
  error: string | null;
  failures: number;
  retryAt: number;
  /** When the connection came up; null while it is down. */
  connectedAt: number | null;
};

export const disconnected = (): Reconnecting => ({
  status: "disconnected",
  error: null,
  failures: 0,
  retryAt: 0,
  connectedAt: null,
});

/** An attempt starts. */
export const connecting = (state: Reconnecting) => {
  state.status = "connecting";
  state.error = null;
};

/** The connection came up. A status its owner already reported stands. */
export const connectionUp = (state: Reconnecting, now: number) => {
  state.connectedAt = now;

  if (state.status === "connecting") state.status = "connected";
};

/** Forgets the failures once the connection has held long enough. */
export const stayedUp = (state: Reconnecting, now: number) => {
  if (
    state.connectedAt !== null &&
    now - state.connectedAt >= STABLE_CONNECTION_MS
  )
    state.failures = 0;
};

/** The transport reports its own status. */
export const reported = (
  state: Reconnecting,
  status: ConnectionStatus,
  errorText: string,
) => {
  state.status = status;
  state.error = status === "error" ? errorText : null;
};

/** It can't connect until something changes, such as its settings. */
export const blocked = (state: Reconnecting, error: string) => {
  state.status = "error";
  state.error = error;
};

/** It was closed on purpose. */
export const stopped = (state: Reconnecting, error = state.error) => {
  state.status = "disconnected";
  state.error = error;
  state.connectedAt = null;
};

/** Records one more failure; the next attempt waits at least `atLeastMs`. */
export const connectionFailed = (
  state: Reconnecting,
  now: number,
  error: string,
  atLeastMs = 0,
) => {
  state.connectedAt = null;
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
