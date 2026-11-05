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
import type { Runner } from "../shared/runner";
import { LearnedChangeRepository } from "../learned-changes/learned-change-repository";

type Services =
  | AgentRepository
  | ConversationRepository
  | LearnedChangeRepository;

type Exec = Runner<Services>["runSync"];

export function registerActivityRoutes(options: {
  register: Register;
  service: BotLookup;
  runtime: AgentRuntime;
  run: Runner<Services>;
}) {
  const { register, service, runtime } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.activity, async (c) => {
    const input = c.req.valid("query");
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;

    if (input.cursor && !cursor)
      throw new InvalidInput({ message: "Invalid cursor" });

    const agents = input.agentId
      ? [service.agent(input.agentId)]
      : exec(AgentRepository.use((r) => r.list));

    const feed: z.output<typeof activityFeedResponse> = await activityPage({
      // History is durable per agent; skip bots that have never opened a conversation so
      // this read-only feed does not initialize empty chats.
      agents: agents.filter(
        (agent) =>
          exec(ConversationRepository.use((r) => r.list(agent.id, true)))
            .length,
      ),
      history: (agent, before, limit) =>
        runtime.history(agent, {
          limit,
          before,
          includeActiveAssistant: true,
        }),
      changes: (limit, before) =>
        exec(
          LearnedChangeRepository.use((r) =>
            r.list(input.agentId, { limit, before }),
          ),
        ),
      agentName: (id) =>
        exec(AgentRepository.use((r) => r.get(id)))?.name ?? null,
      limit: input.limit,
      cursor,
      kind: input.kind,
    });

    return c.json(feed, 200);
  });
}
