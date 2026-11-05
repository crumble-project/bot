import { Effect, Layer } from "effect";
import { BotExtensions, ExtensionPosition } from "../bots/bot-extensions";
import { Bots } from "../bots/bots";
import { BotMessaging } from "../bot-messaging/bot-messaging";
import { jobExtensions, pluginJobKinds, Plugins } from "../plugins/plugins";

/** Runs each subscription until the layer's scope closes. */
const whileOpen = (subscribe: () => ReadonlyArray<() => void>) =>
  Effect.acquireRelease(Effect.sync(subscribe), (stops) =>
    Effect.sync(() => {
      for (const stop of stops) stop();
    }),
  );

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

/** Announces each bot's answer to a job's report as a reply. */
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

/** Passes each job question to the bot that delegated the job's task. */
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
                // The owner still sees the question's card and can answer it.
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
