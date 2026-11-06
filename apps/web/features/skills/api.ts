import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  listedSkillResponse,
  skillPackageResponse,
} from "@crumble/server/contract/api-responses";
import type {
  pendingSkillUpdateResponse,
  skillCheckResponse,
  skillListingResponse,
} from "@crumble/server/contract/skill-install";
import { agentPath } from "@/features/bots/api";
import { api, call } from "@/lib/api";

export type ListedSkill = z.infer<typeof listedSkillResponse>;

export type SharedSkill = Extract<ListedSkill, { source: "shared" }>;

export type SkillPackage = z.infer<typeof skillPackageResponse>;

export type SkillListing = z.infer<typeof skillListingResponse>;

export type PendingSkillUpdate = z.infer<typeof pendingSkillUpdateResponse>;

export type SkillCheck = z.infer<typeof skillCheckResponse>;

export const skillPath = (id: string) =>
  `/v1/skills/${encodeURIComponent(id)}` as const;

export const botSkillsPath = (botId: string) =>
  `${agentPath(botId)}/skills` as const;

export const botSkillPath = (botId: string, skillId: string) =>
  `${botSkillsPath(botId)}/${encodeURIComponent(skillId)}` as const;

export const botSkillsKey = ["bot-skills"];

export const botSkillsQuery = (botId: string) =>
  queryOptions({
    queryKey: [...botSkillsKey, botId],
    queryFn: ({ signal }) =>
      api<"agentSkills">(botSkillsPath(botId), { signal }),
  });

export const skillsQuery = queryOptions({
  queryKey: ["skills"],
  queryFn: ({ signal }) => api<"skills">("/v1/skills", { signal }),
});

export const assignSkill = (
  skillId: string,
  botId: string,
  assigned: boolean,
) =>
  call<"assignSkillBot">(`${skillPath(skillId)}/assignment`, "POST", {
    botId,
    assigned,
  });

export const checkSkillUpdates = () =>
  call<"checkSkillUpdates">("/v1/skills/updates/check", "POST");
