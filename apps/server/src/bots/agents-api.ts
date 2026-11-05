import { patchInput, routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { McpServerRepository } from "../integrations/mcp-server-repository";
import type { McpServers } from "../integrations/mcp-servers";
import type { SkillRepository } from "../skills/skill-repository";
import { botSecretsPrefix } from "../secrets/secret-key";
import { Secrets } from "../secrets/secrets";
import { agentInput } from "../shared/domain";
import type { Runner } from "../shared/runner";
import { AgentRepository } from "./agent-repository";
import { duplicateAgent } from "./agent-duplicate";
import type { BotsAccess } from "./bots";
import { usesDesktop } from "../bot-desktop/desktop-vocabulary";

type Services =
  | AgentRepository
  | McpServerRepository
  | SkillRepository
  | Secrets;

type Exec = Runner<Services>["runSync"];

type AgentRoutesOptions = {
  register: Register;
  service: BotsAccess;
  /** Runs the repository effects the bot routes read and write. */
  run: Runner<Services>;
  /** Accepts a provider ID only if this server can serve it. */
  provider: { parse(value: string): string };
  mcpServers: McpServers;
  /** Stops a bot's workspace machine, so its next use boots the image its tools need now. */
  restartWorkspace?: ((agentId: string) => Promise<void>) | undefined;
};

/** The owner's view of every bot, and the editing of a bot's own configuration. */
const registerAgentDefinitionRoutes = (options: AgentRoutesOptions) => {
  const { register, service } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.listAgents, async (c) =>
    c.json(
      (await service.agentPreviews()).map(({ agent, lastMessage }) => {
        return lastMessage ? { ...agent, lastMessage } : agent;
      }),
      200,
    ),
  );
  register(routes.createAgent, async (c) => {
    const input = agentInput.parse(await c.req.json());

    options.provider.parse(input.provider);
    options.mcpServers.check(null, input.mcpServers, true);

    return c.json(exec(AgentRepository.use((r) => r.create(input))), 201);
  });
  register(routes.getAgent, (c) =>
    c.json(service.agent(c.req.param("id")), 200),
  );
  register(routes.updateAgent, async (c) => {
    const old = service.agent(c.req.param("id"));
    const body = patchInput(agentInput).parse(await c.req.json());

    // The inline skills are a view of the bot's packages, which may outgrow the inline limit; only a submitted list is validated.
    const { skills, ...input } = agentInput.parse({
      ...old,
      ...body,
      skills: body["skills"] ?? [],
    });

    options.provider.parse(input.provider);
    options.mcpServers.check(old.id, input.mcpServers);

    if (!input.enabled && old.enabled) await service.stopAgent(old.id);

    const updated = exec(
      AgentRepository.use((r) =>
        r.update(old.id, body["skills"] ? { ...input, skills } : input),
      ),
    );

    // The desktop tool picks the workspace image; a bot that gains or loses it needs a fresh boot.
    if (usesDesktop(old) !== usesDesktop(input))
      await options.restartWorkspace?.(old.id);

    return c.json(updated, 200);
  });
};

/** Copying a bot, and deleting one along with the secrets of the MCP servers it owned. */
const registerAgentLifecycleRoutes = (options: AgentRoutesOptions) => {
  const { register, service, mcpServers } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.duplicateAgent, (c) => {
    service.agent(c.req.param("id"));

    return c.json(exec(duplicateAgent(c.req.param("id"))), 201);
  });
  register(routes.deleteAgent, async (c) => {
    const id = c.req.param("id");

    await mcpServers.forgetBot(id, () => service.deleteAgent(id));
    exec(Secrets.use((s) => s.deleteAll(botSecretsPrefix(id))));

    return c.body(null, 204);
  });
};

/** The bot routes, in the order the contract document lists them. */
export function registerAgentRoutes(options: AgentRoutesOptions) {
  registerAgentDefinitionRoutes(options);
  registerAgentLifecycleRoutes(options);
}
