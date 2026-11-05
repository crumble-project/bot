import {
  PROTOCOL_VERSION,
  relayMessage,
  type Ack,
  type EventMessage,
} from "@doorstep/protocol";
import { Clock, Context, DateTime, Effect, Layer } from "effect";
import { z } from "zod";
import type { ConnectionStatus } from "../shared/domain";
import { Secrets, secretText } from "../secrets/secrets";
import { pluginSettingKey } from "../plugins/plugins";
import { InvalidInput } from "../shared/errors";
import {
  connectionFailed,
  credentialsChanged,
  disconnected,
  tokenOrFailure,
} from "../shared/reconnecting";
import { SettingsRepository } from "../shared/settings-repository";
import { startTicking } from "../shared/ticker";
import { connectUrl, type RelayAccess } from "./doorstep-client";
import { EventRepository, type RelayEvent } from "./event-repository";
import { DOORSTEP_PLUGIN_ID } from "./plugin";

export const RELAY_URL_SETTING = "event-relay:url";

export const RELAY_TOKEN_KEY = pluginSettingKey(DOORSTEP_PLUGIN_ID, "token");

export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type RelayStatus = {
  url: string | null;
  tokenConfigured: boolean;
  status: ConnectionStatus;
  error: string | null;
};

// A hello the protocol schema rejects still names the version the relay speaks.
const anyHello = z.object({ type: z.literal("hello"), protocol: z.number() });

const relayUrlOf = z.string().nullable().catch(null);

const textFrame = z.string();

const jsonValue = z.json();

// SAFETY: lib.dom's WebSocket type hides Bun's constructor options; Bun's WebSocket accepts `headers`.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- lib.dom and Bun declare the same global
const RelaySocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

type Connection = {
  socket: WebSocket;
  greeted: boolean;
};

const eventOf = (message: EventMessage): RelayEvent => ({
  id: message.id,
  sourceId: message.sourceId,
  receivedAt: message.receivedAt,
  method: message.method,
  query: message.query,
  headers: message.headers,
  body: message.body,
});

/** The account's connection to its event relay: it stores every event the relay sends, then acknowledges it. */
export class EventRelay extends Context.Service<
  EventRelay,
  {
    readonly status: Effect.Effect<RelayStatus>;
    /** The relay URL and account token, for calls to the relay's API. */
    readonly access: Effect.Effect<RelayAccess, InvalidInput>;
    /** Connects, reconnects, or disconnects to match the settings. */
    readonly tick: Effect.Effect<void>;
    /** Ticks every second until the account closes. */
    readonly start: Effect.Effect<void>;
  }
>()("crumble/event-sources/EventRelay") {
  static readonly layer = Layer.effect(
    EventRelay,
    Effect.gen(function* () {
      const settings = yield* SettingsRepository;
      const secrets = yield* Secrets;
      const events = yield* EventRepository;
      const readSecret = secretText(secrets);
      const scope = yield* Effect.scope;
      const run = Effect.runPromiseWith(yield* Effect.context<never>());

      const state = disconnected();
      let connection: Connection | undefined;
      let configured: string | undefined;
      // Set by a protocol mismatch; only a settings change clears it.
      let blocked = false;
      let pruneAt = 0;
      let closed = false;

      const relayUrl = settings
        .get(RELAY_URL_SETTING)
        .pipe(Effect.map((value) => relayUrlOf.parse(value)));

      const disconnect = () => {
        const current = connection;
        connection = undefined;
        current?.socket.close();
      };

      const send = (socket: WebSocket, message: Ack) =>
        socket.send(JSON.stringify(message));

      const lost = (current: Connection) =>
        Effect.gen(function* () {
          if (connection !== current) return;
          connection = undefined;

          if (blocked) return;
          connectionFailed(
            state,
            yield* Clock.currentTimeMillis,
            current.greeted
              ? "Lost the connection to the event relay. Reconnecting automatically."
              : "Can't connect to the event relay. Check its URL and token; reconnecting automatically.",
          );
        });

      const receive = (current: Connection, data: string) =>
        Effect.gen(function* () {
          if (connection !== current) return;

          const json = yield* Effect.try(() =>
            jsonValue.parse(JSON.parse(data)),
          ).pipe(Effect.orElseSucceed(() => null));

          const message = relayMessage.safeParse(json);

          if (!message.success) {
            const hello = anyHello.safeParse(json);

            if (hello.success) {
              blocked = true;
              state.status = "error";
              state.error = `The relay speaks protocol ${hello.data.protocol}; this server needs ${PROTOCOL_VERSION}.`;
              disconnect();
            }

            return;
          }

          if (message.data.type === "hello") {
            current.greeted = true;
            state.failures = 0;
            state.status = "connected";
            state.error = null;

            return;
          }

          const { id } = message.data;

          yield* events.storeEvent(eventOf(message.data)).pipe(
            Effect.matchCause({
              onFailure: () => {
                state.error =
                  "An event could not be stored. Check server storage; the relay sends it again.";
              },
              onSuccess: () => {
                if (connection === current)
                  send(current.socket, { type: "ack", id });
              },
            }),
          );
        });

      const connect = (access: RelayAccess) => {
        const socket = new RelaySocket(connectUrl(access.url), {
          headers: { Authorization: `Bearer ${access.token}` },
        });

        const current: Connection = { socket, greeted: false };

        connection = current;
        state.status = "connecting";
        state.error = null;
        socket.addEventListener("message", (message) => {
          const text = textFrame.safeParse(message.data);

          if (text.success) void run(receive(current, text.data));
        });
        socket.addEventListener("close", () => {
          if (!closed) void run(lost(current));
        });
      };

      const token = tokenOrFailure(readSecret(RELAY_TOKEN_KEY));

      const unconfigured = (
        url: string | null,
        failure: string | undefined,
      ) => {
        disconnect();
        configured = undefined;
        state.status = url ? "error" : "disconnected";
        state.error = url
          ? (failure ?? "Configure the Doorstep account token.")
          : null;
      };

      // New settings get a fresh connection and clear a protocol mismatch.
      const reconfigure = (key: string) => {
        if (key === configured) return;
        disconnect();
        configured = key;
        blocked = false;
        credentialsChanged(state);
      };

      const reconcile = Effect.gen(function* () {
        const url = yield* relayUrl;
        const read = yield* token;

        if (!url || !read.token) return unconfigured(url, read.failure);
        reconfigure(`${url}\n${read.token}`);

        if (blocked || connection) return;

        if (state.retryAt > (yield* Clock.currentTimeMillis)) return;
        connect({ url, token: read.token });
      });

      const prune = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        if (now < pruneAt) return;
        pruneAt = now + PRUNE_INTERVAL_MS;
        yield* events.prune(
          DateTime.formatIso(DateTime.makeUnsafe(now - EVENT_RETENTION_MS)),
        );
      });

      const tick = Effect.gen(function* () {
        if (closed) return;
        yield* reconcile;
        yield* prune;
      }).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            state.error =
              "The event relay settings could not be loaded. Check server storage.";
          }),
        ),
      );

      const describe = Effect.gen(function* () {
        const stored = yield* secrets.status(RELAY_TOKEN_KEY);

        return {
          url: yield* relayUrl,
          tokenConfigured: stored.configured,
          status: state.status,
          error: state.error,
        };
      });

      const access = Effect.gen(function* () {
        const url = yield* relayUrl;
        const read = yield* token;

        if (!url)
          return yield* new InvalidInput({
            message: "Set the event relay URL first.",
          });

        if (!read.token)
          return yield* new InvalidInput({
            message:
              read.failure ?? "Configure the Doorstep account token first.",
          });

        return { url, token: read.token };
      });

      const start = startTicking(tick, scope);

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          disconnect();
        }),
      );

      return EventRelay.of({ status: describe, access, tick, start });
    }),
  );
}
