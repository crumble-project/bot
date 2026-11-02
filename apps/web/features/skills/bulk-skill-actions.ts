import {
  type Bot,
  type ListedSkill,
  type SkillCheck,
  agentPath,
  api,
  call,
  send,
} from "@/lib/api";
import { invalidateSkill } from "./skill-cache";

export type SelectableSkill = {
  id: string;
  name: string;
  instructions: string;
  botId: string | null;
  ownerName: string;
  installed: boolean;
};

export type BulkAction = "delete" | "update" | "assign" | "remove";

export const skillLabel = (skill: SelectableSkill) =>
  `${skill.name} (${skill.ownerName})`;

const skillPath = (skill: SelectableSkill) =>
  `/v1/skills/${encodeURIComponent(skill.id)}`;

type UpdateCheck = {
  catalog: ListedSkill[];
  check: SkillCheck;
  error?: unknown;
};

/** The existing checker refreshes upstream metadata; only selected skills are applied. */
async function checkUpdates(): Promise<UpdateCheck> {
  try {
    const check = await call<SkillCheck>("/v1/skills/updates/check", "POST");

    return { check, catalog: await api<ListedSkill[]>("/v1/skills") };
  } catch (error) {
    return { catalog: [], check: { failed: [] }, error };
  }
}

async function updateSkill(skill: SelectableSkill, updates: UpdateCheck) {
  if (!skill.installed) return "not installed from GitHub";

  if (updates.error) throw updates.error;
  const current = updates.catalog.find((each) => each.id === skill.id);

  if (!current || current.source !== "shared" || !current.origin)
    throw new Error("Installed skill no longer exists.");

  const failure = updates.check.failed.find(
    (each) =>
      each.repository === current.origin?.repository &&
      each.branch === current.origin?.branch,
  );

  if (failure) throw new Error(failure.message);

  if (!current.update) return "already up to date";
  await send(`${skillPath(skill)}/update`, "POST");
  await invalidateSkill(skill.id);

  return null;
}

async function assignBots(
  skill: SelectableSkill,
  bots: Bot[],
  assigned: boolean,
  messages: string[],
) {
  let failed = false;

  for (const bot of bots) {
    const label = `${skillLabel(skill)} → ${bot.name}`;

    try {
      const result = await call<
        { skipped: boolean },
        { botId: string; assigned: boolean }
      >(`${skillPath(skill)}/assignment`, "POST", { botId: bot.id, assigned });

      if (result.skipped)
        messages.push(`Skipped ${label}: already in the requested state.`);
    } catch (error) {
      failed = true;
      messages.push(
        `Failed ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return failed;
}

async function applySkillAction(
  skill: SelectableSkill,
  action: BulkAction,
  updates: UpdateCheck | undefined,
  bots: Bot[],
  messages: string[],
) {
  if (action === "delete") {
    const path = skill.botId
      ? `${agentPath(skill.botId)}/skills/${encodeURIComponent(skill.id)}`
      : skillPath(skill);

    await send(path, "DELETE");

    return false;
  }

  if (updates) {
    const skipped = await updateSkill(skill, updates);

    if (skipped) messages.push(`Skipped ${skillLabel(skill)}: ${skipped}.`);

    return false;
  }

  return assignBots(skill, bots, action === "assign", messages);
}

/** Each request is independent: keep failures selected, never roll back successes. */
export async function applyBulkAction(
  action: BulkAction,
  picked: SelectableSkill[],
  bots: Bot[],
) {
  const failed = new Set<string>();
  const messages: string[] = [];
  const updates = action === "update" ? await checkUpdates() : undefined;

  for (const skill of picked) {
    try {
      if (await applySkillAction(skill, action, updates, bots, messages))
        failed.add(skill.id);
    } catch (error) {
      failed.add(skill.id);
      messages.push(
        `Failed ${skillLabel(skill)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  messages.unshift(
    `${picked.length - failed.size} of ${picked.length} skills processed${failed.size ? `; ${failed.size} failed and remain selected` : ""}.`,
  );

  return { failed, messages };
}
