import type { JsonValue } from "@earendil-works/chord";
import { Clock, Effect, Fiber, Result, Semaphore } from "effect";
import {
  defaultGatewayConfig,
  gatewayConfigInput,
  type GatewayConfig,
} from "../contract/message-gateway";
import { Secrets, secretText } from "../secrets/secrets";
import { InvalidInput, type AppError } from "../shared/errors";
import {
  blocked,
  connecting,
  connectionFailed,
  connectionUp,
  credentialsChanged,
  disconnected,
  reported,
  stayedUp,
  stopped,
  tokenOrFailure,
  type Reconnecting,
} from "../shared/reconnecting";
import { SettingsRepository } from "../shared/settings-repository";
import {
  GatewayTransportError,
  type ChatAdapter,
  type GatewayConnection,
  type GatewayMessage,
} from "./adapter";

const configKey = (id: string) => `message-gateway:${id}`;

export const transport = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      cause instanceof GatewayTransportError
        ? cause
        : new GatewayTransportError("Gateway transport failed", {
            permanent: false,
          }),
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError((cause) =>
      cause instanceof GatewayTransportError
        ? cause
        : new GatewayTransportError("Gateway transport timed out", {
            permanent: false,
          }),
    ),
  );

export const decodeConfig = (input: JsonValue | GatewayConfig) =>
  Effect.suspend(() => {
    const result = gatewayConfigInput.safeParse(input);

    return result.success
      ? Effect.succeed(result.data)
      : Effect.fail(
          new InvalidInput({
            message:
              "Invalid message gateway configuration. Configure a single owner user ID and save again.",
          }),
        );
  });

type ConnectionState = Reconnecting & {
  connection?: GatewayConnection | undefined;
  token?: string | undefined;
  generation: number;
  invalidated: boolean;
};

type ConnectionHooks = {
  receive: (
    adapterId: string,
    message: GatewayMessage,
  ) => Effect.Effect<void, AppError>;
  cancelWorkers: (adapterId: string) => Effect.Effect<void>;
  connected: Effect.Effect<void>;
};

export type CurrentConnection = {
  connection: GatewayConnection;
  generation: number;
  token: string | undefined;
};

export const gatewayConnections = Effect.fnUntraced(function* (
  adapters: readonly ChatAdapter[],
  hooks: ConnectionHooks,
) {
  const settings = yield* SettingsRepository;
  const secrets = yield* Secrets;
  const scope = yield* Effect.scope;
  const run = Effect.runPromiseWith(yield* Effect.context());
  let closed = false;

  const states = new Map<string, ConnectionState>(
    adapters.map((adapter) => [
      adapter.id,
      { ...disconnected(), generation: 0, invalidated: false },
    ]),
  );

  const reconciling = new Set<string>();
  const reconfiguring = new Set<string>();
  const configurationChanges = Semaphore.makeUnsafe(1);

  const config = Effect.fnUntraced(function* (id: string) {
    const stored = yield* settings.get(configKey(id));

    return yield* decodeConfig(stored ?? defaultGatewayConfig()).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          states.get(id)!.error = error.message;

          return defaultGatewayConfig();
        }),
      ),
    );
  });

  const stop = Effect.fnUntraced(function* (state: ConnectionState) {
    state.generation++;
    const connection = state.connection;
    state.connection = undefined;
    state.invalidated = false;
    stopped(state);

    if (connection) {
      const closing = transport(() => connection.close()).pipe(
        Effect.catch(() => Effect.void),
      );

      yield* closing;
    }
  });

  const readSecret = secretText(secrets);

  const readToken = (adapter: ChatAdapter) => readSecret(adapter.secretKey);

  const generationCurrent = (adapterId: string, generation: number) =>
    !closed && states.get(adapterId)!.generation === generation;

  const configureConnection = Effect.fnUntraced(function* (
    adapter: ChatAdapter,
    state: ConnectionState,
    current: GatewayConfig,
    token: string | undefined,
    tokenError?: string,
  ) {
    if (!current.enabled || !token) {
      yield* hooks.cancelWorkers(adapter.id);

      if (state.connection || state.token) yield* stop(state);
      state.token = undefined;

      if (current.enabled)
        blocked(
          state,
          tokenError ?? "Configure the adapter token in plugin settings.",
        );
      else stopped(state);

      return false;
    }

    if (state.token !== token) {
      yield* hooks.cancelWorkers(adapter.id);
      yield* stop(state);
      state.token = token;
      credentialsChanged(state);
    }

    return true;
  });

  const invalidateConnection = Effect.fnUntraced(function* (
    adapter: ChatAdapter,
    state: ConnectionState,
    now: number,
  ) {
    yield* hooks.cancelWorkers(adapter.id);
    yield* stop(state);
    connectionFailed(
      state,
      now,
      "The adapter connection was invalidated. Reconnecting automatically.",
    );
  });

  const connectionOptions = (
    adapter: ChatAdapter,
    state: ConnectionState,
    token: string,
    generation: number,
  ): Parameters<ChatAdapter["connect"]>[0] => {
    return {
      token,
      onMessage: (message) =>
        closed || state.generation !== generation
          ? Promise.resolve()
          : run(
              hooks.receive(adapter.id, message).pipe(
                Effect.catchCause(() =>
                  Effect.sync(() => {
                    state.error =
                      "Incoming message persistence failed. Check server storage and resend the message.";
                  }),
                ),
                Effect.forkIn(scope),
                Effect.flatMap(Fiber.join),
              ),
            ),
      onStatus: (status) => {
        if (closed || state.generation !== generation) return;
        reported(
          state,
          status,
          "The adapter reported an error. Check its token, intents, and permissions.",
        );
      },
      onInvalidated: () => {
        if (closed || state.generation !== generation) return;
        state.invalidated = true;
      },
    };
  };

  const connectAdapter = Effect.fnUntraced(function* (
    adapter: ChatAdapter,
    state: ConnectionState,
    token: string,
    generation: number,
  ) {
    return yield* transport(() =>
      adapter
        .connect(connectionOptions(adapter, state, token, generation))
        .then(async (connection) => {
          if (closed || state.generation !== generation) {
            await connection.close();

            return undefined;
          }

          return connection;
        }),
    ).pipe(Effect.result);
  });

  const readyToConnect = Effect.fnUntraced(function* (
    adapter: ChatAdapter,
    state: ConnectionState,
    now: number,
  ) {
    if (state.invalidated) {
      yield* invalidateConnection(adapter, state, now);

      return false;
    }

    if (state.connection) {
      stayedUp(state, now);

      return false;
    }

    return !(state.retryAt > now);
  });

  const reconcile = Effect.fnUntraced(function* (adapter: ChatAdapter) {
    if (reconfiguring.has(adapter.id)) return;
    const state = states.get(adapter.id)!;
    const current = yield* config(adapter.id);
    const { token, failure } = yield* tokenOrFailure(readToken(adapter));
    const now = yield* Clock.currentTimeMillis;

    if (!(yield* configureConnection(adapter, state, current, token, failure)))
      return;

    if (!(yield* readyToConnect(adapter, state, now))) return;
    const generation = ++state.generation;

    connecting(state);

    const connected = yield* connectAdapter(adapter, state, token!, generation);

    if (!generationCurrent(adapter.id, generation)) return;

    if (Result.isSuccess(connected)) {
      state.connection = connected.success;

      if (state.connection) connectionUp(state, now);
      yield* hooks.connected;
    } else {
      state.generation++;
      connectionFailed(
        state,
        now,
        "Gateway login failed. Check its token, intents, and connection; reconnecting automatically.",
        connected.failure.details.retryAfterMs ?? 0,
      );
    }
  });

  const reconcileAll = Effect.gen(function* () {
    for (const adapter of adapters) {
      if (reconciling.has(adapter.id)) continue;
      reconciling.add(adapter.id);
      yield* reconcile(adapter).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            states.get(adapter.id)!.error =
              "Gateway configuration could not be loaded. Check server storage.";
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            reconciling.delete(adapter.id);
          }),
        ),
        Effect.forkIn(scope),
      );
    }
  });

  const current = (adapterId: string): CurrentConnection | null => {
    const state = states.get(adapterId);

    return state?.connection &&
      !state.invalidated &&
      !reconfiguring.has(adapterId)
      ? {
          connection: state.connection,
          generation: state.generation,
          token: state.token,
        }
      : null;
  };

  const live = (adapterId: string, generation: number) =>
    generationCurrent(adapterId, generation);

  const holds = (
    adapterId: string,
    connection: GatewayConnection,
    generation: number,
  ) =>
    live(adapterId, generation) &&
    states.get(adapterId)!.connection === connection &&
    !reconfiguring.has(adapterId);

  /** Stops the adapter's connection and workers, then stores `next`; the next reconcile connects with it. */
  const reconfigure = (id: string, next: GatewayConfig) =>
    Semaphore.withPermit(
      configurationChanges,
      Effect.gen(function* () {
        reconfiguring.add(id);
        const state = states.get(id)!;

        yield* stop(state);
        yield* hooks.cancelWorkers(id);
        yield* settings.set(configKey(id), next);
        state.error = null;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            reconfiguring.delete(id);
          }),
        ),
      ),
    );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;

      for (const state of states.values()) yield* stop(state);
    }),
  );

  return {
    config,
    reconcileAll,
    current,
    live,
    holds,
    reconfigure,
    readToken,
    installed: (id: string) => states.has(id),
    isClosed: () => closed,
    status: (id: string) => {
      const { status, error } = states.get(id)!;

      return { status, error };
    },
    note: (id: string, error: string | null) => {
      const state = states.get(id);

      if (state) state.error = error;
    },
  };
});

export type GatewayConnections = Effect.Success<
  ReturnType<typeof gatewayConnections>
>;
