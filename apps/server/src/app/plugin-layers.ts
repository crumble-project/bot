import { Effect, Layer } from "effect";
import { BotExtensions, ExtensionPosition } from "../bots/bot-extensions";
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
