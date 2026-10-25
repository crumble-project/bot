import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import {
  MAX_SKILL_DOCUMENTS,
  skillDocumentInput,
  skillInput,
  type Agent,
  type Skill,
  type SkillInput,
} from "../shared/domain";
import { Effect } from "effect";
import {
  resolveSkill,
  skillToolContext,
  SkillToolError,
  type SkillReads,
} from "./skill-library";
import type { BotSkills } from "./skills";

const refuse = (message: string) =>
  Effect.fail(new SkillToolError({ message }));

export const SKILL_MANAGE_TOOL_NAME = "skill_manage";

const MAX_OPERATIONS = 10;

/** Advisory findings about the shape of a skill; they never block a write. */
export type SkillFinding = { skill: string; rule: string; message: string };

const OVERSIZED_BODY = 12000;
const DOCUMENT_SPRAWL = 15;

const INCIDENT_MARKERS =
  /(?:#\d{2,}|\bPR\s?\d+|\bissue\s?\d+|\b20\d\d-\d\d-\d\d\b)/gi;

export function lintSkill(skill: SkillInput): SkillFinding[] {
  const findings: SkillFinding[] = [];

  if (!skill.description.trim())
    findings.push({
      skill: skill.name,
      rule: "missing-description",
      message:
        "Add a one-line description that says when the skill applies; it is all the index shows.",
    });

  if (skill.instructions.length > OVERSIZED_BODY)
    findings.push({
      skill: skill.name,
      rule: "oversized-body",
      message: `The instructions exceed ${OVERSIZED_BODY} characters and stay in context once loaded; move depth that is only needed sometimes into reference documents.`,
    });

  if ((skill.instructions.match(INCIDENT_MARKERS) ?? []).length >= 3)
    findings.push({
      skill: skill.name,
      rule: "incident-log-shape",
      message:
        "The instructions read like a log of incidents (issue numbers, dates). Write each lesson once as a rule with its reason; the rule must stand without the story.",
    });

  if (skill.documents.length >= DOCUMENT_SPRAWL)
    findings.push({
      skill: skill.name,
      rule: "document-sprawl",
      message: `The skill has ${skill.documents.length} reference documents; extend one named by topic instead of adding one per session.`,
    });

  return findings;
}

const name = Type.String({ minLength: 1, maxLength: 100 });
const path = Type.String({ minLength: 1, maxLength: 200 });

const operation = Type.Union([
  Type.Object({
    action: Type.Literal("create"),
    name,
    description: Type.Optional(Type.String({ maxLength: 300 })),
    instructions: Type.String({ minLength: 1, maxLength: 32000 }),
    documents: Type.Optional(
      Type.Array(
        Type.Object({
          path,
          content: Type.String({ minLength: 1, maxLength: 64000 }),
        }),
        { maxItems: MAX_SKILL_DOCUMENTS },
      ),
    ),
  }),
  Type.Object({
    action: Type.Literal("patch"),
    name,
    oldString: Type.String({ minLength: 1 }),
    newString: Type.String(),
    path: Type.Optional(path),
    replaceAll: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    action: Type.Literal("rewrite"),
    name,
    instructions: Type.String({ minLength: 1, maxLength: 32000 }),
    description: Type.Optional(Type.String({ maxLength: 300 })),
  }),
  Type.Object({
    action: Type.Literal("write_document"),
    name,
    path,
    content: Type.String({ minLength: 1, maxLength: 64000 }),
  }),
  Type.Object({
    action: Type.Literal("remove_document"),
    name,
    path,
  }),
  Type.Object({ action: Type.Literal("delete"), name }),
]);

type Operation = Static<typeof operation>;

export type SkillManageCallbacks = {
  library: BotSkills["Service"];
  reads: SkillReads;
  agent: () => Agent;
};

type Applied = { action: Operation["action"]; name: string; path?: string };

/** Replaces `oldString` in `source` once, or everywhere with `replaceAll`; an ambiguous or missing match is an error. */
export function applyPatch(
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  label: string,
): Effect.Effect<string, SkillToolError> {
  const count = source.split(oldString).length - 1;

  if (count === 0)
    return refuse(
      `${label} does not contain the text to replace; load it again and copy the passage exactly`,
    );

  if (count > 1 && !replaceAll)
    return refuse(
      `${label} contains the text to replace ${count} times; include more surrounding text or set replaceAll`,
    );

  return Effect.succeed(
    replaceAll
      ? source.split(oldString).join(newString)
      : source.replace(oldString, () => newString),
  );
}

/** The model tool a bot edits its own skills with: an ordered batch, applied atomically. */
export function skillManageTool(callbacks: SkillManageCallbacks) {
  return defineTool({
    name: SKILL_MANAGE_TOOL_NAME,
    description:
      "Create, change, or delete your own skills: your procedural memory for classes of tasks. The call is an ordered list of operations applied atomically; any failure undoes the whole batch. Ops: create (name, description, instructions, documents), patch (oldString/newString in the instructions, or in a document with path; preferred for fixes), rewrite (whole instructions), write_document and remove_document (reference documents under references/), delete. Load a skill with the skill tool in this turn before patching, rewriting, or deleting it. Shared and default skills are read-only; create your own skill with the same name to shadow one. Write lessons as rules with their reason, no incident narration or dates; keep the description a one-line trigger.",
    parameters: Type.Object({
      operations: Type.Array(operation, {
        minItems: 1,
        maxItems: MAX_OPERATIONS,
      }),
    }),
    callers: ["model"],
    // A batch is not replay-safe: an interrupted call reports the interruption instead of writing twice.
    replay: "unsafe",
    execute: async (args, api, callContext) => {
      const agent = callbacks.agent();
      const context = await skillToolContext(api, callContext);
      const { library, reads } = callbacks;

      return Effect.runPromise(
        Effect.gen(function* () {
          const available = yield* library.available(agent);
          const applied: Applied[] = [];
          const touched = new Map<string, Skill>();

          const own = (name: string) =>
            library
              .own(agent.id)
              .pipe(
                Effect.map(
                  (skills) =>
                    skills.find(
                      (skill) =>
                        skill.name.toLowerCase() === name.toLowerCase(),
                    ) ?? null,
                ),
              );

          const target = Effect.fnUntraced(function* (operation: Operation) {
            const skill = yield* own(operation.name);

            if (skill) {
              if (!reads.has(context.runKey, skill.id))
                return yield* refuse(
                  `Load skill ${skill.name} with the skill tool in this turn before changing it; writes must follow a current read`,
                );

              return skill;
            }

            const shadowed = resolveSkill(available, operation.name);

            return yield* refuse(
              shadowed
                ? `Skill ${shadowed.name} is ${shadowed.scope} and read-only; create your own skill named ${JSON.stringify(shadowed.name)} to shadow it, then change that`
                : `You have no skill named ${JSON.stringify(operation.name)}; use skill_manage create or check the skill tool's list`,
            );
          });

          const validate = (input: SkillInput) => {
            const parsed = skillInput.safeParse(input);

            return parsed.success
              ? Effect.succeed(parsed.data)
              : refuse(
                  parsed.error.issues
                    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                    .join("; "),
                );
          };

          const update = Effect.fnUntraced(function* (
            skill: Skill,
            patch: Partial<SkillInput>,
          ) {
            const next = yield* validate({ ...skill, ...patch });
            const updated = yield* library.update(skill.id, next, context);
            touched.set(updated.id, updated);

            return updated;
          });

          const apply = Effect.fnUntraced(function* (raw: Operation) {
            const operation = { ...raw, name: raw.name.trim() };

            if (!operation.name)
              return yield* refuse("A skill name is required");

            if (operation.action === "create") {
              if (yield* own(operation.name))
                return yield* refuse(
                  `You already have a skill named ${JSON.stringify(operation.name)}; patch or rewrite it`,
                );

              const created = yield* library.create(
                agent.id,
                yield* validate({
                  name: operation.name,
                  description: operation.description ?? "",
                  instructions: operation.instructions,
                  documents: operation.documents ?? [],
                }),
                context,
              );

              touched.set(created.id, created);
              reads.mark(context.runKey, created.id);
              applied.push({ action: "create", name: created.name });

              return;
            }

            const skill = yield* target(operation);

            if (operation.action === "delete") {
              if (context.reviewOf)
                return yield* refuse(
                  "A review never deletes a skill; patch it, or mention the overlap in your reply",
                );
              yield* library.remove(skill.id, context);
              touched.delete(skill.id);
              applied.push({ action: "delete", name: skill.name });
            } else if (operation.action === "rewrite") {
              yield* update(skill, {
                instructions: operation.instructions,
                ...(operation.description !== undefined && {
                  description: operation.description,
                }),
              });
              applied.push({ action: "rewrite", name: skill.name });
            } else if (operation.action === "patch") {
              if (operation.path) {
                const document = skill.documents.find(
                  (candidate) => candidate.path === operation.path,
                );

                if (!document)
                  return yield* refuse(
                    `Skill ${skill.name} has no document ${operation.path}`,
                  );

                const content = yield* applyPatch(
                  document.content,
                  operation.oldString,
                  operation.newString,
                  operation.replaceAll === true,
                  `Document ${operation.path} of skill ${skill.name}`,
                );

                yield* update(skill, {
                  documents: skill.documents.map((candidate) =>
                    candidate === document
                      ? { ...candidate, content }
                      : candidate,
                  ),
                });
              } else
                yield* update(skill, {
                  instructions: yield* applyPatch(
                    skill.instructions,
                    operation.oldString,
                    operation.newString,
                    operation.replaceAll === true,
                    `Skill ${skill.name}`,
                  ),
                });
              applied.push({
                action: "patch",
                name: skill.name,
                ...(operation.path && { path: operation.path }),
              });
            } else if (operation.action === "write_document") {
              const document = skillDocumentInput.safeParse({
                path: operation.path,
                content: operation.content,
              });

              if (!document.success)
                return yield* refuse(
                  document.error.issues[0]?.message ?? "Invalid document",
                );

              const others = skill.documents.filter(
                (candidate) => candidate.path !== document.data.path,
              );

              yield* update(skill, { documents: [...others, document.data] });
              applied.push({
                action: "write_document",
                name: skill.name,
                path: document.data.path,
              });
            } else {
              if (
                !skill.documents.some(
                  (candidate) => candidate.path === operation.path,
                )
              )
                return yield* refuse(
                  `Skill ${skill.name} has no document ${operation.path}`,
                );
              yield* update(skill, {
                documents: skill.documents.filter(
                  (candidate) => candidate.path !== operation.path,
                ),
              });
              applied.push({
                action: "remove_document",
                name: skill.name,
                path: operation.path,
              });
            }
          });

          yield* library.transaction(
            Effect.forEach(args.operations, apply, { discard: true }),
          );

          const findings = [...touched.values()].flatMap((skill) =>
            lintSkill(skill),
          );

          return {
            output: [
              {
                type: "text" as const,
                text: JSON.stringify({ applied, findings }),
              },
            ],
          };
        }),
      );
    },
  });
}
