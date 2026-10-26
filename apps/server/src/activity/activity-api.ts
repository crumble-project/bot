import type { z } from "zod";
import { activityInput, routes } from "../contract/api-contract";
import type { activityFeedResponse } from "../contract/api-responses";
import type { Register } from "../contract/route";
import { decodeCursor, activityPage } from "./activity";
import { AgentRepository } from "../bots/agent-repository";
import type { AgentRuntime } from "../bots/runtime";
import type { BotsAccess } from "../bots/bots";
import { ConversationRepository } from "../bots/conversation-repository";
import type { CoreServices } from "../shared/core-layer";
import { InvalidInput } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { LearnedChangeRepository } from "../skills/learned-change-repository";

type Exec = Runner<CoreServices>["runSync"];

/** The account-wide activity feed, oldest pages first, from the bots' chat history and learned changes. */
export function registerActivityRoutes(options: {
  register: Register;
  service: BotsAccess;
  runtime: AgentRuntime;
  run: Runner<CoreServices>;
}) {
  const { register, service, runtime } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.activity, async (c) => {
    const input = activityInput.parse(c.req.query());
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
