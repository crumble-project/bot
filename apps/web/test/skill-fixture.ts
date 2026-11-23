import type { ResponseBody } from "@/lib/api";

type Skill = ResponseBody<"agentSkills">[number];

export function skillFixture(
  overrides: Partial<Skill> & Pick<Skill, "id" | "name" | "instructions">,
): Skill {
  return {
    agentId: "bot",
    description: "",
    documents: [],
    createdBy: "owner",
    sourceExecutionId: null,
    useCount: 0,
    lastUsedAt: null,
    state: "active",
    pinned: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}
