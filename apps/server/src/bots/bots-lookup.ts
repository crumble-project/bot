import { Effect } from "effect";
import { pi } from "../shared/app-errors";
import type { Agent } from "../contract/agents";
import { NotFound } from "../shared/errors";
import type { BotsContext } from "./bots-context";

export type BotsLookup = ReturnType<typeof botsLookup>;

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

  const withAgent = <A>(agentId: string, run: (owner: Agent) => Promise<A>) =>
    agent(agentId).pipe(Effect.flatMap((owner) => pi(() => run(owner))));

  return { agent, conversation, withAgent };
};
