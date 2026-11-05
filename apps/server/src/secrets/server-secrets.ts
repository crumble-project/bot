import { Clock, Context, Effect, Layer } from "effect";
import type { z } from "zod";
import { secretKey } from "./secret-key";
import { SecretRepository } from "./secret-repository";

export class ServerSecrets extends Context.Service<
  ServerSecrets,
  {
    readonly get: (key: string) => Effect.Effect<string | undefined>;
    readonly set: (key: string, value: string) => Effect.Effect<void>;
    readonly delete: (key: string) => Effect.Effect<boolean>;
  }
>()("crumble/secrets/ServerSecrets") {
  static readonly layer = Layer.effect(
    ServerSecrets,
    Effect.map(SecretRepository, ({ get, set, delete: remove }) =>
      ServerSecrets.of({ get, set, delete: remove }),
    ),
  );
}

export class PendingStates extends Context.Service<
  PendingStates,
  {
    readonly put: (
      flow: string,
      state: string,
      data: Record<string, string>,
    ) => Effect.Effect<void>;
    /** The saved data; undefined when unknown or older than `ttlMs`. */
    readonly read: <T extends { createdAt: number }>(
      flow: string,
      state: string,
      schema: z.ZodType<T>,
      ttlMs: number,
    ) => Effect.Effect<T | undefined>;
    readonly drop: (flow: string, state: string) => Effect.Effect<void>;
  }
>()("crumble/secrets/PendingStates") {
  static readonly layer = Layer.effect(
    PendingStates,
    Effect.gen(function* () {
      const secrets = yield* SecretRepository;

      return PendingStates.of({
        put: Effect.fnUntraced(function* (flow, state, data) {
          const createdAt = yield* Clock.currentTimeMillis;

          yield* secrets.set(
            secretKey(flow, state),
            JSON.stringify({ ...data, createdAt }),
          );
        }),
        read: <T extends { createdAt: number }>(
          flow: string,
          state: string,
          schema: z.ZodType<T>,
          ttlMs: number,
        ) =>
          Effect.gen(function* () {
            const raw = yield* secrets.get(secretKey(flow, state));
            const parsed = raw ? schema.safeParse(JSON.parse(raw)) : undefined;
            const now = yield* Clock.currentTimeMillis;

            return parsed?.success && now - parsed.data.createdAt <= ttlMs
              ? parsed.data
              : undefined;
          }),
        drop: (flow, state) =>
          Effect.asVoid(secrets.delete(secretKey(flow, state))),
      });
    }),
  );
}
