import { Effect, Exit, Scope } from "effect";
import { BotNotices } from "../../src/bots/bot-notices";
import type { Store } from "./store";

export type Notice = { agentId: string; text: string; requestId: string };

/** Takes the account's bot notices until `stop` closes its scope. */
export function takeNotices(store: Store) {
  const notices: Notice[] = [];
  const scope = store.runtime.runSync(Scope.make());

  store.runtime.runSync(
    BotNotices.use((botNotices) =>
      botNotices.handle((agentId, text, requestId) =>
        Effect.sync(() => {
          notices.push({ agentId, text, requestId });
        }),
      ),
    ).pipe(Scope.provide(scope)),
  );

  return {
    notices,
    stop: () => store.runtime.runSync(Scope.close(scope, Exit.void)),
  };
}
