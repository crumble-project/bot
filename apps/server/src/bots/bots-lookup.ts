import { Effect } from "effect";
import { pi } from "../shared/app-errors";
import type { Agent } from "../shared/domain";
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

  /** Runs a runtime call for the bot `agentId` names. */
  const withAgent = <A>(agentId: string, run: (owner: Agent) => Promise<A>) =>
    agent(agentId).pipe(Effect.flatMap((owner) => pi(() => run(owner))));

  return { agent, conversation, withAgent };
};
