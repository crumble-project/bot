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
    const context = yield* Effect.context<never>();
    const runSync = Effect.runSyncWith(context);

    const holdAwake = (agentId: string, state: ControlState) => {
      if (!machines) return;

      if (state.holder === "owner" && !awake.has(agentId))
        runSync(
          machines.keepAwake(agentId).pipe(
            Effect.map((release) => void awake.set(agentId, release)),
            Effect.ignore,
          ),
        );
      else if (state.holder === "bot") {
        awake.get(agentId)?.();
        awake.delete(agentId);
      }
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => control.subscribeAll(holdAwake)),
      (stop) =>
        Effect.sync(() => {
          stop();

          for (const release of awake.values()) release();
          awake.clear();
        }),
    );

    for (const agent of yield* (yield* AgentRepository).list)
      holdAwake(agent.id, yield* control.get(agent.id));
  }),
);
