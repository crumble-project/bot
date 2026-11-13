import { Effect } from "effect";
import type { Env } from "hono";
import type { z } from "zod";
import { routes } from "../contract/api-contract";
import type { activityFeedResponse } from "../contract/api-responses";
import type { Register } from "../contract/route";
import { decodeCursor, activityPage } from "./activity";
import { AgentRepository } from "../bot-store/agent-repository";
import type { AgentRuntime } from "../bots/runtime";
import type { BotLookup } from "../bot-ports/bot-lookup";
import { ConversationRepository } from "../bot-store/conversation-repository";
import { InvalidInput } from "../shared/errors";
import { accessOf, noServices } from "../shared/runner";
import { LearnedChangeRepository } from "../learned-changes/learned-change-repository";

export function registerActivityRoutes(options: {
  register: Register<
    Env,
    AgentRepository | ConversationRepository | LearnedChangeRepository
  >;
  service: BotLookup;
  runtime: AgentRuntime;
}) {
  const { register, service, runtime } = options;

  register(routes.activity, function* (c) {
    const input = c.req.valid("query");
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;

    if (input.cursor && !cursor)
      return yield* Effect.fail(
        new InvalidInput({ message: "Invalid cursor" }),
      );

    const agentRepo = yield* AgentRepository;
    const conversations = yield* ConversationRepository;
    const learnedChanges = yield* LearnedChangeRepository;
    const allAgents = yield* agentRepo.list;

    const candidateAgents = input.agentId
      ? [service.agent(input.agentId)]
      : allAgents;

    // History is durable per agent; skip bots that have never opened a conversation so
    // this read-only feed does not initialize empty chats.
    const activeAgents = yield* Effect.filter(candidateAgents, (agent) =>
      conversations
        .list(agent.id, true)
        .pipe(Effect.map((items) => items.length > 0)),
    );

    const changesAccess = accessOf(learnedChanges, noServices, ["list"]);

    const agentNames = new Map(
      allAgents.map((agent) => [agent.id, agent.name]),
    );

    const feed: z.output<typeof activityFeedResponse> = yield* Effect.promise(
      () =>
        activityPage({
          agents: activeAgents,
          history: (agent, before, limit) =>
            runtime.history(agent, {
              limit,
              before,
              includeActiveAssistant: true,
            }),
          changes: (limit, before) =>
            changesAccess.list(input.agentId, { limit, before }),
          agentName: (id) => agentNames.get(id) ?? null,
          limit: input.limit,
          cursor,
          kind: input.kind,
        }),
    );

    return c.json(feed, 200);
  });
}
