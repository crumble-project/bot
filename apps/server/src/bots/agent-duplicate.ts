import { Effect } from "effect";
import { McpServerRepository } from "../integrations/mcp-server-repository";
import { OWNER } from "../shared/change-by";
import { SkillRepository } from "../skills/skill-repository";
import { AgentRepository } from "./agent-repository";

/** A copy with the same settings and skill packages; archived skills and the original's own servers stay behind. */
export const duplicateAgent = Effect.fn("duplicateAgent")(function* (
  agentId: string,
  name?: string,
) {
  const agents = yield* AgentRepository;
  const servers = yield* McpServerRepository;
  const skills = yield* SkillRepository;
  const original = yield* agents.get(agentId);

  if (!original) return null;

  // Personal servers keep belonging to the original bot.
  const mcpServers: string[] = [];

  for (const serverId of original.mcpServers)
    if (!(yield* servers.get(serverId))?.agentId) mcpServers.push(serverId);

  const copy = yield* agents.create({
    ...original,
    mcpServers,
    skills: [],
    name: name ?? `${original.name} Copy`,
  });

  // Skill packages are copied whole; archived ones stay behind, and the copy's skills were not learned from an execution.
  for (const skill of yield* skills.list(original.id))
    if (skill.state !== "archived")
      yield* skills.create(
        {
          ...skill,
          agentId: copy.id,
          sourceExecutionId: null,
          state: skill.state,
          pinned: skill.pinned,
        },
        undefined,
        OWNER,
      );

  return yield* agents.get(copy.id);
});
