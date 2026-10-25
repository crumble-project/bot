import type { Context as PiContext } from "@earendil-works/chord";
import { Context, Deferred, Effect, Layer, type ManagedRuntime } from "effect";
import { nowIso } from "../shared/time";
import { DesktopControlRepository } from "./desktop-control-repository";

export type ControlHolder = "bot" | "owner";

/** Who operates a bot desktop. `changes` counts every change of holder, so a plan from before one can be recognized. */
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

/** The control lease of each bot desktop: durable in the database, with listeners for live updates. */
export class DesktopControl extends Context.Service<
  DesktopControl,
  {
    readonly get: (agentId: string) => Effect.Effect<ControlState>;
    readonly set: (
      agentId: string,
      holder: ControlHolder,
    ) => Effect.Effect<ControlState>;
    readonly subscribe: (agentId: string, listener: Listener) => () => void;
    /** Hears every bot's changes, such as to keep a bot desktop awake while the owner holds it. */
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
      const listeners = new Map<string, Set<Listener>>();

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

        for (const listener of listeners.get(agentId) ?? []) listener(next);

        for (const listener of everyBot) listener(agentId, next);

        return next;
      });

      const subscribe = (agentId: string, listener: Listener) => {
        const set = listeners.get(agentId) ?? new Set<Listener>();

        set.add(listener);
        listeners.set(agentId, set);

        return () => void set.delete(listener);
      };

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
        const stop = subscribe(agentId, (state) => {
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

      return DesktopControl.of({ get, set, subscribe, subscribeAll, untilBot });
    }),
  );
}

/** Desktop control for code outside Effect: HTTP handlers, the VNC input filter, and Pi Durable tools. */
export type DesktopControlAccess = {
  get(agentId: string): ControlState;
  set(agentId: string, holder: ControlHolder): ControlState;
  subscribe(agentId: string, listener: Listener): () => void;
  subscribeAll(
    listener: (agentId: string, state: ControlState) => void,
  ): () => void;
  /** Resolves once the bot holds control; cancelling `context` stops the wait. */
  untilBot(agentId: string, context: PiContext): Promise<ControlState>;
};

export function desktopControlAccess(
  runtime: ManagedRuntime.ManagedRuntime<DesktopControl, unknown>,
): DesktopControlAccess {
  const control = runtime.runSync(DesktopControl.use(Effect.succeed));

  return {
    get: (agentId) => runtime.runSync(control.get(agentId)),
    set: (agentId, holder) => runtime.runSync(control.set(agentId, holder)),
    subscribe: control.subscribe,
    subscribeAll: control.subscribeAll,
    untilBot: (agentId, context) =>
      runtime.runPromise(control.untilBot(agentId), {
        signal: context.abortSignal,
      }),
  };
}
