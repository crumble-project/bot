import { Effect } from "effect";
import { patchInput, routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { SecretRepository } from "../credentials/secret-repository";
import type { McpIntegrations } from "../integrations/integrations";
import { signOut, type SecretStorage } from "../integrations/mcp-oauth";
import { McpServerRepository } from "../integrations/mcp-server-repository";
import type { CoreServices } from "../shared/core-layer";
import { agentInput, type AgentInput } from "../shared/domain";
import { InvalidInput } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { AgentRepository } from "./agent-repository";
import type { BotsAccess } from "./bots";
import { ConversationRepository } from "./conversation-repository";

type Exec = Runner<CoreServices>["runSync"];

type AgentRoutesOptions = {
  register: Register;
  service: BotsAccess;
  /** Runs the repository effects the bot routes read and write. */
  run: Runner<CoreServices>;
  /** Accepts a provider ID only if this server can serve it. */
  provider: { parse(value: string): string };
  secrets: SecretStorage;
  integrations?: McpIntegrations["Service"] | undefined;
  /** Stops a bot's workspace machine, so its next use boots the image its tools need now. */
  restartWorkspace?: (agentId: string) => Promise<void>;
};

/** A bot may use shared servers and its own, never another bot's. */
export const checkServers = (
  exec: Exec,
  agentId: string | null,
  serverIds: string[],
  requireExisting = false,
) => {
  for (const serverId of serverIds) {
    const server = exec(McpServerRepository.use((r) => r.get(serverId)));

    if (!server && requireExisting)
      throw new InvalidInput({ message: "That MCP server does not exist" });

    if (!server) continue;

    const owner = server.agentId;

    if (owner && owner !== agentId)
      throw new InvalidInput({
        message: "That MCP server belongs to another bot",
      });
  }
};

export const validateAgentProposal = (
  exec: Exec,
  provider: { parse(value: string): string },
  input: AgentInput,
) => {
  provider.parse(input.provider);
  checkServers(exec, null, input.mcpServers, true);

  return input;
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
    const input = validateAgentProposal(
      exec,
      options.provider,
      agentInput.parse(await c.req.json()),
    );

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
    checkServers(exec, old.id, input.mcpServers);

    if (!input.enabled && old.enabled)
      for (const conversation of exec(
        ConversationRepository.use((r) => r.list(old.id)),
      ))
        await service.abort(conversation.id);

    const updated = exec(
      AgentRepository.use((r) =>
        r.update(old.id, body["skills"] ? { ...input, skills } : input),
      ),
    );

    // The desktop tool picks the workspace image; a bot that gains or loses it needs a fresh boot.
    if (old.tools.includes("desktop") !== input.tools.includes("desktop"))
      await options.restartWorkspace?.(old.id);

    return c.json(updated, 200);
  });
};

/** Copying a bot, and deleting one along with the secrets of the MCP servers it owned. */
const registerAgentLifecycleRoutes = (options: AgentRoutesOptions) => {
  const { register, service, secrets, integrations } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.duplicateAgent, (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      exec(AgentRepository.use((r) => r.duplicate(c.req.param("id")))),
      201,
    );
  });
  register(routes.deleteAgent, async (c) => {
    const personal = exec(McpServerRepository.use((r) => r.list)).filter(
      (server) => server.agentId === c.req.param("id"),
    );

    await service.deleteAgent(c.req.param("id"));

    // The bot's personal servers went with it; their credentials and connections go too.
    for (const server of personal) {
      exec(SecretRepository.use((r) => r.delete(`mcp:${server.id}`)));
      signOut(secrets, server.id);

      if (integrations)
        await Effect.runPromise(integrations.disconnect(server.id));
    }

    return c.body(null, 204);
  });
};

/** The bot routes, in the order the contract document lists them. */
export function registerAgentRoutes(options: AgentRoutesOptions) {
  registerAgentDefinitionRoutes(options);
  registerAgentLifecycleRoutes(options);
}
