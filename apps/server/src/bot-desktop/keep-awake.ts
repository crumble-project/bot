import { Effect, Layer } from "effect";
import { AgentRepository } from "../bots/agent-repository";
import { BotWorkspaces } from "../workspaces/workspace";
import { DesktopControl, type ControlState } from "./desktop-control";

/** Keeps a bot's desktop machine awake while the owner holds control of it. */
export const desktopKeepAwake = Layer.effectDiscard(
  Effect.gen(function* () {
    const machines = yield* BotWorkspaces;
    const control = yield* DesktopControl;
    const awake = new Map<string, () => void>();

    const holdAwake = Effect.fn("DesktopKeepAwake.hold")(function* (
      agentId: string,
      state: ControlState,
    ) {
      if (!machines) return;

      if (state.holder === "owner" && !awake.has(agentId))
        awake.set(agentId, yield* machines.keepAwake(agentId));
      else if (state.holder === "bot") {
        awake.get(agentId)?.();
        awake.delete(agentId);
      }
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const release of awake.values()) release();

        awake.clear();
      }),
    );

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        control.subscribeAll((agentId, state) => {
          Effect.runSync(
            holdAwake(agentId, state).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(
                  "Bot desktop keep-awake failed",
                  agentId,
                  cause,
                ),
              ),
            ),
          );
        }),
      ),
      (stop) => Effect.sync(stop),
    );

    for (const agent of yield* (yield* AgentRepository).list)
      yield* holdAwake(agent.id, yield* control.get(agent.id)).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Bot desktop keep-awake failed", agent.id, cause),
        ),
      );
  }),
);
