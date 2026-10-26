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
  type AvailableSkill,
  type SkillReads,
  type SkillToolContext,
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

type CreateOperation = Extract<Operation, { action: "create" }>;

type PatchOperation = Extract<Operation, { action: "patch" }>;

type RewriteOperation = Extract<Operation, { action: "rewrite" }>;

type WriteDocumentOperation = Extract<Operation, { action: "write_document" }>;

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

/** The batch being applied: the library, the turn's reads, and what the batch has written so far. */
type Batch = {
  library: BotSkills["Service"];
  reads: SkillReads;
  agentId: string;
  context: SkillToolContext;
  available: AvailableSkill[];
  applied: Applied[];
  touched: Map<string, Skill>;
};

const ownSkill = (batch: Batch, name: string) =>
  batch.library
    .own(batch.agentId)
    .pipe(
      Effect.map(
        (skills) =>
          skills.find(
            (skill) => skill.name.toLowerCase() === name.toLowerCase(),
          ) ?? null,
      ),
    );

const validateSkill = (input: SkillInput) => {
  const parsed = skillInput.safeParse(input);

  return parsed.success
    ? Effect.succeed(parsed.data)
    : refuse(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
};

const updateSkill = Effect.fnUntraced(function* (
  batch: Batch,
  skill: Skill,
  patch: Partial<SkillInput>,
) {
  const next = yield* validateSkill({ ...skill, ...patch });
  const updated = yield* batch.library.update(skill.id, next, batch.context);
  batch.touched.set(updated.id, updated);

  return updated;
});

const targetSkill = Effect.fnUntraced(function* (
  batch: Batch,
  operation: Operation,
) {
  const skill = yield* ownSkill(batch, operation.name);

  if (skill) {
    if (!batch.reads.has(batch.context.runKey, skill.id))
      return yield* refuse(
        `Load skill ${skill.name} with the skill tool in this turn before changing it; writes must follow a current read`,
      );

    return skill;
  }

  const shadowed = resolveSkill(batch.available, operation.name);

  return yield* refuse(
    shadowed
      ? `Skill ${shadowed.name} is ${shadowed.scope} and read-only; create your own skill named ${JSON.stringify(shadowed.name)} to shadow it, then change that`
      : `You have no skill named ${JSON.stringify(operation.name)}; use skill_manage create or check the skill tool's list`,
  );
});

const createSkill = Effect.fnUntraced(function* (
  batch: Batch,
  operation: CreateOperation,
) {
  if (yield* ownSkill(batch, operation.name))
    return yield* refuse(
      `You already have a skill named ${JSON.stringify(operation.name)}; patch or rewrite it`,
    );

  const created = yield* batch.library.create(
    batch.agentId,
    yield* validateSkill({
      name: operation.name,
      description: operation.description ?? "",
      instructions: operation.instructions,
      documents: operation.documents ?? [],
    }),
    batch.context,
  );

  batch.touched.set(created.id, created);
  batch.reads.mark(batch.context.runKey, created.id);
  batch.applied.push({ action: "create", name: created.name });
});

const deleteSkill = Effect.fnUntraced(function* (batch: Batch, skill: Skill) {
  if (batch.context.reviewOf)
    return yield* refuse(
      "A review never deletes a skill; patch it, or mention the overlap in your reply",
    );

  yield* batch.library.remove(skill.id, batch.context);
  batch.touched.delete(skill.id);
  batch.applied.push({ action: "delete", name: skill.name });
});

const rewriteSkill = Effect.fnUntraced(function* (
  batch: Batch,
  skill: Skill,
  operation: RewriteOperation,
) {
  yield* updateSkill(batch, skill, {
    instructions: operation.instructions,
    ...(operation.description !== undefined && {
      description: operation.description,
    }),
  });
  batch.applied.push({ action: "rewrite", name: skill.name });
});

const patchDocument = Effect.fnUntraced(function* (
  batch: Batch,
  skill: Skill,
  documentPath: string,
  operation: PatchOperation,
) {
  const document = skill.documents.find(
    (candidate) => candidate.path === documentPath,
  );

  if (!document)
    return yield* refuse(`Skill ${skill.name} has no document ${documentPath}`);

  const content = yield* applyPatch(
    document.content,
    operation.oldString,
    operation.newString,
    operation.replaceAll === true,
    `Document ${documentPath} of skill ${skill.name}`,
  );

  yield* updateSkill(batch, skill, {
    documents: skill.documents.map((candidate) =>
      candidate === document ? { ...candidate, content } : candidate,
    ),
  });
});

const patchSkill = Effect.fnUntraced(function* (
  batch: Batch,
  skill: Skill,
  operation: PatchOperation,
) {
  if (operation.path)
    yield* patchDocument(batch, skill, operation.path, operation);
  else
    yield* updateSkill(batch, skill, {
      instructions: yield* applyPatch(
        skill.instructions,
        operation.oldString,
        operation.newString,
        operation.replaceAll === true,
        `Skill ${skill.name}`,
      ),
    });

  batch.applied.push({
    action: "patch",
    name: skill.name,
    ...(operation.path && { path: operation.path }),
  });
});

const writeDocument = Effect.fnUntraced(function* (
  batch: Batch,
  skill: Skill,
  operation: WriteDocumentOperation,
) {
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

  yield* updateSkill(batch, skill, { documents: [...others, document.data] });
  batch.applied.push({
    action: "write_document",
    name: skill.name,
    path: document.data.path,
  });
});

const removeDocument = Effect.fnUntraced(function* (
  batch: Batch,
  skill: Skill,
  documentPath: string,
) {
  if (!skill.documents.some((candidate) => candidate.path === documentPath))
    return yield* refuse(`Skill ${skill.name} has no document ${documentPath}`);

  yield* updateSkill(batch, skill, {
    documents: skill.documents.filter(
      (candidate) => candidate.path !== documentPath,
    ),
  });
  batch.applied.push({
    action: "remove_document",
    name: skill.name,
    path: documentPath,
  });
});

const applyOperation = Effect.fnUntraced(function* (
  batch: Batch,
  raw: Operation,
) {
  const operation = { ...raw, name: raw.name.trim() };

  if (!operation.name) return yield* refuse("A skill name is required");

  if (operation.action === "create")
    return yield* createSkill(batch, operation);
  const skill = yield* targetSkill(batch, operation);

  switch (operation.action) {
    case "delete":
      return yield* deleteSkill(batch, skill);
    case "rewrite":
      return yield* rewriteSkill(batch, skill, operation);
    case "patch":
      return yield* patchSkill(batch, skill, operation);
    case "write_document":
      return yield* writeDocument(batch, skill, operation);
    case "remove_document":
      return yield* removeDocument(batch, skill, operation.path);
  }
});

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
          const batch: Batch = {
            library,
            reads,
            context,
            agentId: agent.id,
            available: yield* library.available(agent),
            applied: [],
            touched: new Map(),
          };

          yield* library.transaction(
            Effect.forEach(
              args.operations,
              (operation) => applyOperation(batch, operation),
              { discard: true },
            ),
          );

          const findings = [...batch.touched.values()].flatMap((skill) =>
            lintSkill(skill),
          );

          return {
            output: [
              {
                type: "text" as const,
                text: JSON.stringify({ applied: batch.applied, findings }),
              },
            ],
          };
        }),
      );
    },
  });
}
