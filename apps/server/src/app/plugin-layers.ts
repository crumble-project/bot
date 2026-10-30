import { Effect, Layer } from "effect";
import { BotExtensions, ExtensionPosition } from "../bots/bot-extensions";
import { HeldActions, type HeldAction } from "../bot-desktop/held-actions";
import { Bots } from "../bots/bots";
import { jobExtensions, pluginJobKinds, Plugins } from "../plugins/plugins";

/** Offers bots the job tools of the plugins' job kinds. */
export const jobTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const jobKinds = pluginJobKinds(yield* Plugins);

    yield* (yield* BotExtensions).register(
      ExtensionPosition.jobs,
      (agent) => jobExtensions(jobKinds, agent).chat,
    );
  }),
);

/** Announces each bot's answer to a job's report as a reply, until the layer's scope closes. */
export const jobAnswers = Layer.effectDiscard(
  Effect.gen(function* () {
    const bots = yield* Bots;
    const jobKinds = pluginJobKinds(yield* Plugins);

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        jobKinds.map((kind) =>
          kind.onAnswer((answer) =>
            Effect.runSync(bots.announceJobAnswer(answer)),
          ),
        ),
      ),
      (stops) =>
        Effect.sync(() => {
          for (const stop of stops) stop();
        }),
    );
  }),
);

/** Announces each desktop job action held for the owner's approval, so clients notify the owner who must decide. */
export const heldActionNotices = Layer.effectDiscard(
  Effect.gen(function* () {
    const bots = yield* Bots;
    const held = yield* HeldActions;

    const announce = Effect.fn("HeldActions.announce")(function* (
      action: HeldAction,
    ) {
      const agent = yield* bots.agent(action.agentId);

      yield* bots.announce({
        type: "reply",
        executionId: action.id,
        agentId: agent.id,
        agentName: agent.name,
        entryId: null,
        origin: "desktop",
        jobName: action.job,
        waitingFor: "approval",
        preview: `Waiting for your approval: ${action.action}`,
        createdAt: action.heldAt,
      });
    });

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        held.onHeld((action) =>
          Effect.runFork(
            announce(action).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Held action notice failed", cause),
              ),
            ),
          ),
        ),
      ),
      (stop) => Effect.sync(stop),
    );
  }),
);
