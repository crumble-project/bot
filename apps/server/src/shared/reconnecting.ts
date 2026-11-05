import { Effect } from "effect";
import type { ConnectionStatus } from "./domain";

export const backoff = (baseMs: number, attempt: number) =>
  Math.min(baseMs * 2 ** Math.min(attempt - 1, 20), 900_000);

const reconnectDelay = (attempt: number) => backoff(60_000, attempt);

const STABLE_CONNECTION_MS = 5 * 60 * 1000;

export type Reconnecting = {
  status: ConnectionStatus;
  error: string | null;
  failures: number;
  retryAt: number;
  connectedAt: number | null;
};

export const disconnected = (): Reconnecting => ({
  status: "disconnected",
  error: null,
  failures: 0,
  retryAt: 0,
  connectedAt: null,
});

export const connecting = (state: Reconnecting) => {
  state.status = "connecting";
  state.error = null;
};

export const connectionUp = (state: Reconnecting, now: number) => {
  state.connectedAt = now;

  if (state.status === "connecting") state.status = "connected";
};

export const stayedUp = (state: Reconnecting, now: number) => {
  if (
    state.connectedAt !== null &&
    now - state.connectedAt >= STABLE_CONNECTION_MS
  )
    state.failures = 0;
};

export const reported = (
  state: Reconnecting,
  status: ConnectionStatus,
  errorText: string,
) => {
  state.status = status;
  state.error = status === "error" ? errorText : null;
};

export const blocked = (state: Reconnecting, error: string) => {
  state.status = "error";
  state.error = error;
};

export const stopped = (state: Reconnecting, error = state.error) => {
  state.status = "disconnected";
  state.error = error;
  state.connectedAt = null;
};

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

export const credentialsChanged = (state: Reconnecting) => {
  state.failures = 0;
  state.retryAt = 0;
};

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
