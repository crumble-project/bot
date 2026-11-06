import { Effect, Layer } from "effect";
import { BotExtensions, ExtensionPosition } from "../bot-ports/bot-extensions";
import { Bots } from "../bots/bots";
import { BotMessaging } from "../bot-messaging/bot-messaging";
import { jobExtensions, pluginJobKinds, Plugins } from "../plugins/plugins";

const whileOpen = (subscribe: () => ReadonlyArray<() => void>) =>
  Effect.acquireRelease(Effect.sync(subscribe), (stops) =>
    Effect.sync(() => {
      for (const stop of stops) stop();
    }),
  );

export const jobTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const jobKinds = pluginJobKinds(yield* Plugins);

    yield* (yield* BotExtensions).register(
      ExtensionPosition.jobs,
      (agent) => jobExtensions(jobKinds, agent).chat,
    );
  }),
);

export const jobAnswers = Layer.effectDiscard(
  Effect.gen(function* () {
    const bots = yield* Bots;
    const jobKinds = pluginJobKinds(yield* Plugins);

    yield* whileOpen(() =>
      jobKinds.map((kind) =>
        kind.onAnswer((answer) =>
          Effect.runSync(bots.announceJobAnswer(answer)),
        ),
      ),
    );
  }),
);

export const jobQuestions = Layer.effectDiscard(
  Effect.gen(function* () {
    const messaging = yield* BotMessaging;
    const jobKinds = pluginJobKinds(yield* Plugins);

    yield* whileOpen(() =>
      jobKinds.flatMap(
        (kind) =>
          kind.onQuestion?.((asked) =>
            Effect.runPromise(
              messaging.relayQuestion(asked).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Job question relay failed", cause),
                ),
                Effect.asVoid,
              ),
            ),
          ) ?? [],
      ),
    );
  }),
);
