import type { Bot } from "@/features/bots/api";
import { defaultAvatarDefinition } from "@crumble/server/contract/avatar";

export function agentFixture(
  overrides: Partial<Bot> & Pick<Bot, "id" | "name">,
): Bot {
  return {
    avatar: defaultAvatarDefinition(overrides.id),
    description: "",
    instructions: "",
    provider: "test",
    model: "test",
    enabled: true,
    status: "idle",
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
