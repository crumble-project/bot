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

export const personalSkillsPath = (botId: string) =>
  `${agentPath(botId)}/skills` as const;

export const personalSkillPath = (botId: string, skillId: string) =>
  `${personalSkillsPath(botId)}/${encodeURIComponent(skillId)}` as const;

/** Every bot's personal skills, for refreshing them together. */
export const personalSkillsKey = ["personal-skills"];

export const personalSkillsQuery = (botId: string) =>
  queryOptions({
    queryKey: [...personalSkillsKey, botId],
    queryFn: ({ signal }) =>
      api<"agentSkills">(personalSkillsPath(botId), { signal }),
  });

export const skillsQuery = queryOptions({
  queryKey: ["skills"],
  queryFn: ({ signal }) => api<"skills">("/v1/skills", { signal }),
});

/** Turns a shared skill on or off for one bot; the answer says whether it already was. */
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
