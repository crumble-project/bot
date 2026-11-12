import type { Context as PiContext } from "@earendil-works/chord";
import { Context, Deferred, Effect, Layer } from "effect";
import type { CONTROL_HOLDERS } from "../shared/domain";
import { keyedListeners } from "../shared/keyed";
import { accessOf, type Access, type Runner } from "../shared/runner";
import { nowIso } from "../shared/time";
import { DesktopControlRepository } from "./desktop-control-repository";

export type ControlHolder = (typeof CONTROL_HOLDERS)[number];

export type ControlState = {
  holder: ControlHolder;
  changes: number;
  updatedAt: string;
};

type Listener = (state: ControlState) => void;

const UNCHANGED: ControlState = {
  holder: "bot",
  changes: 0,
  updatedAt: new Date(0).toISOString(),
};

export class DesktopControl extends Context.Service<
  DesktopControl,
  {
    readonly get: (agentId: string) => Effect.Effect<ControlState>;
    readonly set: (
      agentId: string,
      holder: ControlHolder,
    ) => Effect.Effect<ControlState>;
    readonly subscribe: (agentId: string, listener: Listener) => () => void;
    readonly subscribeAll: (
      listener: (agentId: string, state: ControlState) => void,
    ) => () => void;
    /** Succeeds once the bot holds control: at once, or when the owner hands it back. */
    readonly untilBot: (agentId: string) => Effect.Effect<ControlState>;
  }
>()("crumble/bot-desktop/DesktopControl") {
  static readonly layer = Layer.effect(
    DesktopControl,
    Effect.gen(function* () {
      const repository = yield* DesktopControlRepository;
      const listeners = keyedListeners<ControlState>();

      const everyBot = new Set<
        (agentId: string, state: ControlState) => void
      >();

      const get = Effect.fn("DesktopControl.get")(function* (agentId: string) {
        return (yield* repository.get(agentId)) ?? UNCHANGED;
      });

      const set = Effect.fn("DesktopControl.set")(function* (
        agentId: string,
        holder: ControlHolder,
      ) {
        const current = yield* get(agentId);

        if (current.holder === holder) return current;

        const next: ControlState = {
          holder,
          changes: current.changes + 1,
          updatedAt: yield* nowIso,
        };

        yield* repository.set(agentId, next);

        listeners.notify(agentId, next);

        for (const listener of everyBot) listener(agentId, next);

        return next;
      });

      const subscribeAll = (
        listener: (agentId: string, state: ControlState) => void,
      ) => {
        everyBot.add(listener);

        return () => void everyBot.delete(listener);
      };

      const untilBot = Effect.fn("DesktopControl.untilBot")(function* (
        agentId: string,
      ) {
        const handedBack = yield* Deferred.make<ControlState>();

        // Listening before reading, so a hand-back between the two is not missed.
        const stop = listeners.add(agentId, (state) => {
          if (state.holder === "bot")
            Deferred.doneUnsafe(handedBack, Effect.succeed(state));
        });

        const current = yield* get(agentId);

        if (current.holder === "bot") {
          stop();

          return current;
        }

        return yield* Deferred.await(handedBack).pipe(
          Effect.ensuring(Effect.sync(stop)),
        );
      });

      return DesktopControl.of({
        get,
        set,
        subscribe: listeners.add,
        subscribeAll,
        untilBot,
      });
    }),
  );
}

const SYNC_DESKTOP_CONTROL = ["get", "set"] as const;

export type DesktopControlAccess = Omit<
  Access<DesktopControl["Service"], (typeof SYNC_DESKTOP_CONTROL)[number]>,
  "untilBot"
> & {
  /** Resolves once the bot holds control; cancelling `context` stops the wait. */
  untilBot(agentId: string, context: PiContext): Promise<ControlState>;
};

export function desktopControlAccess(
  runtime: Runner<DesktopControl>,
): DesktopControlAccess {
  const control = runtime.runSync(DesktopControl.use(Effect.succeed));

  return {
    ...accessOf(control, runtime, SYNC_DESKTOP_CONTROL),
    untilBot: (agentId, context) =>
      runtime.runPromise(control.untilBot(agentId), {
        signal: context.abortSignal,
      }),
  };
}
