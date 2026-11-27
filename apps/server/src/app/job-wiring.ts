import { Effect, Layer } from "effect";
import { BotExtensions, ExtensionPosition } from "../bot-ports/bot-extensions";
import { BotNeeds } from "../bot-ports/bot-needs";
import { AgentRepository } from "../bot-store/agent-repository";
import { ConversationRepository } from "../bot-store/conversation-repository";
import { Bots } from "../bots/bots";
import { BotRuntime } from "../bots/runtime";
import { BotMessaging } from "../bot-messaging/bot-messaging";
import { jobExtensions, pluginJobKinds, Plugins } from "../plugins/plugins";

const whileOpen = (subscribe: () => ReadonlyArray<() => void>) =>
  Effect.acquireRelease(Effect.sync(subscribe), (stops) =>
    Effect.sync(() => {
      for (const stop of stops) {
        stop();
      }
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

export const jobNeeds = Layer.effectDiscard(
  Effect.gen(function* () {
    const needs = yield* BotNeeds;
    const agents = yield* AgentRepository;
    const conversations = yield* ConversationRepository;
    const runtime = yield* BotRuntime;
    const jobKinds = pluginJobKinds(yield* Plugins);

    yield* needs.provide(
      Effect.fnUntraced(function* (agentId) {
        const agent = yield* agents.get(agentId);

        if (!agent || !(yield* conversations.list(agentId, true)).length) {
          return undefined;
        }

        return yield* Effect.promise(() => runtime.jobNeed(agent));
      }),
    );

    yield* whileOpen(() =>
      jobKinds.flatMap(
        (kind) =>
          kind.onChange?.(
            (agentId) => void Effect.runPromise(needs.changed(agentId)),
          ) ?? [],
      ),
    );
  }),
);

export const jobAnswers = Layer.effectDiscard(
  Effect.gen(function* () {
    const bots = yield* Bots;
    const jobKinds = pluginJobKinds(yield* Plugins);

    yield* whileOpen(() =>
      jobKinds.map((kind) =>
        kind.onAnswer(
          (answer) =>
            void Effect.runPromise(
              bots.announceJobAnswer(answer).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Job answer announcement failed", cause),
                ),
                Effect.asVoid,
              ),
            ),
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
