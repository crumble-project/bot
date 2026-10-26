import { Effect } from "effect";
import { NotFound } from "../shared/errors";
import type { BotsContext } from "./bots-context";

/** The bot or the chat an operation names, failing with `NotFound` when it is archived or gone. */
export const botsLookup = (context: BotsContext) => {
  const { agents, conversations } = context;

  const agent = Effect.fn("Bots.agent")(function* (id: string) {
    const found = yield* agents.get(id);

    if (!found)
      return yield* Effect.fail(new NotFound({ message: "Agent not found" }));

    return found;
  });

  const conversation = Effect.fn("Bots.conversation")(function* (id: string) {
    const found = yield* conversations.get(id);

    if (!found || found.archived)
      return yield* Effect.fail(
        new NotFound({ message: "Conversation not found" }),
      );

    return { conversation: found, agent: yield* agent(found.agentId) };
  });

  return { agent, conversation };
};
