import { type Bot } from "@/features/bots/api";
import type { ListedSkill, SkillCheck } from "./api";
import { api, send } from "@/lib/api";
import { invalidateSkill } from "./skill-cache";
import { assignSkill, checkSkillUpdates, skillPath, botSkillPath } from "./api";

export type SelectableSkill = {
  id: string;
  name: string;
  instructions: string;
  botId: string | null;
  ownerName: string;
  installed: boolean;
};

export type BulkMessage = { id: string; text: string };

export type BulkAction = "delete" | "update" | "assign" | "remove";

export const skillLabel = (skill: SelectableSkill) =>
  `${skill.name} (${skill.ownerName})`;

type UpdateCheck = {
  catalog: ListedSkill[];
  check: SkillCheck;
  error?: unknown;
};

async function checkUpdates(): Promise<UpdateCheck> {
  try {
    const check = await checkSkillUpdates();

    return { check, catalog: await api<"skills">("/v1/skills") };
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
  await send<"applySkillUpdate">(`${skillPath(skill.id)}/update`, "POST");
  await invalidateSkill(skill.id);

  return null;
}

async function assignBot(skill: SelectableSkill, bot: Bot, assigned: boolean) {
  const label = `${skillLabel(skill)} → ${bot.name}`;
  const messages: BulkMessage[] = [];

  try {
    const result = await assignSkill(skill.id, bot.id, assigned);

    if (result.skipped)
      messages.push({
        id: `skipped:${skill.id}:${bot.id}`,
        text: `Skipped ${label}: already in the requested state.`,
      });

    return { failed: false, messages };
  } catch (error) {
    messages.push({
      id: `failed:${skill.id}:${bot.id}`,
      text: `Failed ${label}: ${error instanceof Error ? error.message : String(error)}`,
    });

    return { failed: true, messages };
  }
}

/** Different bots are independent; cap requests at four and retain input-order results.
 * Skills still run in order so two operations never race on the same bot's assignments.
 */
async function assignBots(
  skill: SelectableSkill,
  bots: Bot[],
  assigned: boolean,
  messages: BulkMessage[],
) {
  let next = 0;
  const results: Awaited<ReturnType<typeof assignBot>>[] = [];

  const work = async (): Promise<void> => {
    const index = next++;
    const bot = bots[index];

    if (!bot) return;
    results[index] = await assignBot(skill, bot, assigned);

    return work();
  };

  await Promise.all(Array.from({ length: Math.min(4, bots.length) }, work));
  messages.push(...results.flatMap((result) => result.messages));

  return results.some((result) => result.failed);
}

async function deleteSkill(skill: SelectableSkill) {
  await send<"deleteAgentSkill" | "deleteSkill">(
    skill.botId ? botSkillPath(skill.botId, skill.id) : skillPath(skill.id),
    "DELETE",
  );

  return false;
}

function updater(updates: UpdateCheck, messages: BulkMessage[]) {
  return async (skill: SelectableSkill) => {
    const skipped = await updateSkill(skill, updates);

    if (skipped)
      messages.push({
        id: `skipped:${skill.id}`,
        text: `Skipped ${skillLabel(skill)}: ${skipped}.`,
      });

    return false;
  };
}

export async function applyBulkAction(
  action: BulkAction,
  picked: SelectableSkill[],
  bots: Bot[],
) {
  const failed = new Set<string>();
  const messages: BulkMessage[] = [];

  const assigner = (skill: SelectableSkill) =>
    assignBots(skill, bots, action === "assign", messages);

  let apply = assigner;

  if (action === "delete") apply = deleteSkill;

  if (action === "update") apply = updater(await checkUpdates(), messages);

  // Skills run in order, so two operations never race on one bot's assignments.
  for (const skill of picked) {
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      if (await apply(skill)) failed.add(skill.id);
    } catch (error) {
      failed.add(skill.id);
      messages.push({
        id: `failed:${skill.id}`,
        text: `Failed ${skillLabel(skill)}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  messages.unshift({
    id: "summary",
    text: `${picked.length - failed.size} of ${picked.length} skills processed${failed.size ? `; ${failed.size} failed and remain selected` : ""}.`,
  });

  return { failed, messages };
}
