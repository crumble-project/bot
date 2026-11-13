import { Effect } from "effect";
import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { agentInput } from "../contract/agents";
import type { McpServerRepository } from "../integrations/mcp-server-repository";
import type { McpServers } from "../integrations/mcp-servers";
import type { SkillRepository } from "../skills/skill-repository";
import { AgentRepository } from "../bot-store/agent-repository";
import { checkBotChoices } from "./bot-choices";
import { duplicateAgent } from "./agent-duplicate";
import type { BotsAccess } from "./bots";
import { usesDesktop } from "../contract/tools";
import type { Workspaces } from "../workspaces/workspace";

type AgentRoutesOptions = {
  register: Register<
    Env,
    AgentRepository | McpServerRepository | McpServers | SkillRepository
  >;
  service: BotsAccess;
  provider: { parse(value: string): string };
  workspaces: Workspaces | undefined;
};

const registerAgentDefinitionRoutes = (options: AgentRoutesOptions) => {
  const { register, service, provider } = options;

  register.plain(routes.listAgents, async (c) =>
    c.json(
      (await service.agentPreviews()).map(({ agent, lastMessage }) => {
        return lastMessage ? { ...agent, lastMessage } : agent;
      }),
      200,
    ),
  );
  register(routes.createAgent, function* (c) {
    const input = c.req.valid("json");

    yield* checkBotChoices(provider, input, null);
    const agents = yield* AgentRepository;

    return c.json(yield* agents.create(input), 201);
  });
  register.plain(routes.getAgent, (c) =>
    c.json(service.agent(c.req.param("id")), 200),
  );
  register(routes.updateAgent, function* (c) {
    const old = service.agent(c.req.param("id"));
    const body = c.req.valid("json");

    const { skills, ...input } = agentInput.parse({
      ...old,
      ...body,
      skills: body["skills"] ?? [],
    });

    yield* checkBotChoices(provider, input, old.id);

    if (!input.enabled && old.enabled)
      yield* Effect.promise(() => service.stopAgent(old.id));

    const agents = yield* AgentRepository;

    const updated = yield* agents.update(
      old.id,
      body["skills"] ? { ...input, skills } : input,
    );

    // The desktop tool picks the workspace image; a bot that gains or loses it needs a fresh boot.
    if (options.workspaces && usesDesktop(old) !== usesDesktop(input))
      yield* options.workspaces.restart(old.id);

    return c.json(updated, 200);
  });
};

const registerAgentLifecycleRoutes = (options: AgentRoutesOptions) => {
  const { register, service } = options;

  register(routes.duplicateAgent, function* (c) {
    service.agent(c.req.param("id"));

    return c.json(yield* duplicateAgent(c.req.param("id")), 201);
  });
  register.plain(routes.deleteAgent, async (c) => {
    await service.deleteAgent(c.req.param("id"));

    return c.body(null, 204);
  });
};

export function registerAgentRoutes(options: AgentRoutesOptions) {
  registerAgentDefinitionRoutes(options);
  registerAgentLifecycleRoutes(options);
}
