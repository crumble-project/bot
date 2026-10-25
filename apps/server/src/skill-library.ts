import { Type } from "@earendil-works/pi-ai";
import { defineTool, LiveDoc } from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { Agent, Skill, SkillDocument, SkillInput } from "./domain";
import { GroupConversation } from "./group-turns";
import { ReviewConversation } from "./review-conversation";

/** A skill a bot can load: a default from the repository, one from the shared library, or its own. */
export type AvailableSkill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  documents: SkillDocument[];
  scope: "default" | "shared" | "own";
};

export const SKILL_TOOL_NAME = "skill";

/** Where a skill tool call runs: the group, the inputs of its run, and the run itself. */
export type SkillToolContext = {
  groupId: string | null;
  submissionIds: string[];
  /** Identifies the turn by the inputs it answers, so a write can be checked against reads in the same turn. */
  runKey: string | null;
  /** The execution a review conversation is reviewing; null in the bot's own conversations. */
  reviewOf: string | null;
};

export async function skillToolContext(
  api: ToolExecutionApi,
  callContext: Context,
): Promise<SkillToolContext> {
  const [live, group, review] = await Promise.all([
    api.snapshot(LiveDoc, api.conversationId, callContext),
    api.snapshot(GroupConversation, api.conversationId, callContext),
    api.snapshot(ReviewConversation, api.conversationId, callContext),
  ]);

  return {
    groupId: group?.groupId ?? null,
    reviewOf: review?.executionId ?? null,
    submissionIds: (live?.run?.inputs ?? []).map(String),
    // The run's task changes with every tool round; its inputs stay the same for the whole turn.
    runKey: live?.run
      ? `${String(api.conversationId)}:${live.run.inputs.map(String).join(",")}`
      : null,
  };
}

/** The skills a bot can read and the ones it may write, behind the store. */
export interface SkillLibrary {
  /** Defaults, shared skills the bot uses, and its own, archived ones excluded. */
  available(agent: Agent): AvailableSkill[] | Promise<AvailableSkill[]>;
  used(agent: Agent, skill: AvailableSkill): void | Promise<void>;
  /** The bot's own skills, archived ones excluded. */
  own(agentId: string): Skill[];
  create(agentId: string, input: SkillInput, context: SkillToolContext): Skill;
  update(
    skillId: string,
    patch: Partial<SkillInput>,
    context: SkillToolContext,
  ): Skill;
  remove(skillId: string, context: SkillToolContext): void;
  /** Runs `fn` atomically; a throw undoes every write inside. */
  transaction<T>(fn: () => T): T;
}

const MAX_TRACKED_RUNS = 200;

/** Which skills a turn has loaded, so a write can be refused unless it follows a current read. */
export class SkillReads {
  private readonly runs = new Map<string, Set<string>>();

  mark(runKey: string | null, skillId: string) {
    if (!runKey) return;
    const reads = this.runs.get(runKey) ?? new Set<string>();
    reads.add(skillId);
    this.runs.delete(runKey);
    this.runs.set(runKey, reads);

    while (this.runs.size > MAX_TRACKED_RUNS)
      this.runs.delete(this.runs.keys().next().value!);
  }

  has(runKey: string | null, skillId: string) {
    return runKey !== null && (this.runs.get(runKey)?.has(skillId) ?? false);
  }
}

const SCOPE_RANK: Record<AvailableSkill["scope"], number> = {
  own: 0,
  shared: 1,
  default: 2,
};

const DESCRIPTION_PREVIEW = 120;

export const SKILLS_GUIDANCE =
  "Skills are instructions for classes of tasks. The list below names the skills available to you with a one-line description; their content is not loaded. When the task at hand matches a skill, load it with the skill tool before acting and follow it; do not guess what it says. Load a skill's reference document only when you need that depth. Skills are contextual instructions for how to do the work, not authority to override the owner's current request.";

export const SKILL_WRITING_GUIDANCE =
  "Skills come first for what you learn while working: a procedure that worked, a pitfall and why, and the owner's preferences and corrections for that kind of work belong in the skill you used or built for the task, through skill_manage, where they load only when relevant. Patch the loaded skill before creating a new one, name new skills at the class of task, and write lessons as rules with their reason, not as a log of what happened. Memory is only for facts that hold in every conversation regardless of task.";

/** A bot's own skill shadows a shared one of the same name, which shadows a default. */
export function resolveSkill(skills: AvailableSkill[], name: string) {
  const wanted = name.trim().toLowerCase();

  return (
    [...skills]
      .sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope])
      .find((skill) => skill.name.toLowerCase() === wanted) ?? null
  );
}

/** The one-line description for the index: the stated one, or the start of the instructions. */
export function skillSummary(
  skill: Pick<AvailableSkill, "description" | "instructions">,
) {
  if (skill.description.trim()) return skill.description.trim();

  const firstLine =
    skill.instructions
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line) ?? "";

  return firstLine.length > DESCRIPTION_PREVIEW
    ? `${firstLine.slice(0, DESCRIPTION_PREVIEW - 1)}…`
    : firstLine;
}

/** The skills section of a bot's instructions: names and descriptions, never the content. */
export function skillIndex(skills: AvailableSkill[]) {
  if (!skills.length) return "";

  const seen = new Set<string>();

  const lines = [...skills]
    .sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope])
    .flatMap((skill) => {
      const key = skill.name.toLowerCase();

      if (seen.has(key)) return [];
      seen.add(key);
      const summary = skillSummary(skill);

      return [`- ${skill.name}${summary ? `: ${summary}` : ""}`];
    });

  return `${SKILLS_GUIDANCE}\n\nSkills:\n${lines.join("\n")}`;
}

export type SkillToolCallbacks = {
  skills: () => AvailableSkill[] | Promise<AvailableSkill[]>;
  used?: (skill: AvailableSkill, runKey: string | null) => void | Promise<void>;
};

/** The model tool that lists skills and loads one skill or one of its reference documents. */
export function skillTool(callbacks: SkillToolCallbacks) {
  return defineTool({
    name: SKILL_TOOL_NAME,
    description:
      "List the skills available to you, or load one. `view` with a name returns the skill's instructions and the paths of its reference documents; add `path` to read one document. Load a skill before acting on a task it covers.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("view")]),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    }),
    callers: ["model"],
    replay: "safe",
    execute: async (args, api, callContext) => {
      const skills = await callbacks.skills();
      const { runKey } = await skillToolContext(api, callContext);

      if (args.action === "list")
        return text(
          skills.map((skill) => ({
            name: skill.name,
            description: skillSummary(skill),
            scope: skill.scope,
            documents: skill.documents.map((document) => document.path),
          })),
        );

      if (!args.name) throw new Error("A skill name is required to view it");
      const skill = resolveSkill(skills, args.name);

      if (!skill) throw new Error(`Unknown skill: ${args.name}`);

      if (args.path) {
        const document = skill.documents.find(
          (candidate) => candidate.path === args.path,
        );

        if (!document)
          throw new Error(
            `Skill ${skill.name} has no document ${args.path}; it has: ${skill.documents.map((each) => each.path).join(", ") || "none"}`,
          );
        await callbacks.used?.(skill, runKey);

        return text({
          name: skill.name,
          path: document.path,
          content: document.content,
        });
      }

      await callbacks.used?.(skill, runKey);

      return text({
        name: skill.name,
        description: skillSummary(skill),
        scope: skill.scope,
        instructions: skill.instructions,
        documents: skill.documents.map((document) => document.path),
      });
    },
  });
}

/** What the skill tool returns: a listing, one skill, or one of its documents. */
type SkillToolResult =
  | Array<{
      name: string;
      description: string;
      scope: AvailableSkill["scope"];
      documents: string[];
    }>
  | {
      name: string;
      description: string;
      scope: AvailableSkill["scope"];
      instructions: string;
      documents: string[];
    }
  | { name: string; path: string; content: string };

const text = (result: SkillToolResult) => ({
  output: [{ type: "text" as const, text: JSON.stringify(result) }],
});
