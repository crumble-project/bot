import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";
import { skillDocumentInput } from "../contract/skills";
import type { SkillDocument } from "./skill-repository";
import { parseSkillMarkdown } from "./skill-markdown";
import { MAX_SKILL_DOCUMENTS, MAX_SKILL_FILE_BYTES } from "../shared/limits";

export type DefaultSkill = {
  id: string;
  name: string;
  description?: string | undefined;
  instructions: string;
  /** Reference documents from the skill's `references` directory, by relative path. */
  documents: SkillDocument[];
  path: string;
};

const MAX_SKILLS = 100;

function loadDocuments(skillDir: string): SkillDocument[] {
  const directory = join(skillDir, "references");

  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];

  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (files.length > MAX_SKILL_DOCUMENTS)
    throw new Error(`Too many reference documents in ${directory}`);

  return files.map((name) => {
    const file = join(directory, name);
    const content = readFileSync(file, "utf8");

    const document = skillDocumentInput.safeParse({
      path: `references/${name}`,
      content,
    });

    if (!document.success)
      throw new Error(`Invalid common skill document: ${file}`);

    return document.data;
  });
}

function parseSkill(
  file: string,
  root: string,
  directory: string,
): DefaultSkill {
  const source = readFileSync(file, "utf8");

  if (Buffer.byteLength(source, "utf8") > MAX_SKILL_FILE_BYTES)
    throw new Error(`Common skill is too large: ${file}`);

  const parsed = parseSkillMarkdown(source);

  if (!parsed) throw new Error(`Invalid common skill frontmatter: ${file}`);
  const { fields, body } = parsed;

  if (!body) throw new Error(`Common skill has no instructions: ${file}`);
  const path = relative(root, file);

  return {
    id: `common:${path}`,
    name: fields.get("name") ?? directory,
    description: fields.get("description"),
    instructions: body,
    documents: loadDocuments(join(root, directory)),
    path,
  };
}

/** Load one SKILL.md from each immediate skill directory.
 * Missing directories are safe for the built-in default, but an explicitly
 * configured directory is treated as a deployment error by the caller.
 */
export function loadDefaultSkills(root: string): DefaultSkill[] {
  const resolved = resolve(root);

  if (!existsSync(resolved)) return [];

  const entries = readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  if (entries.length > MAX_SKILLS)
    throw new Error(`Too many common skills in ${resolved}`);

  return entries.flatMap((entry) => {
    const file = join(resolved, entry.name, "SKILL.md");

    if (!existsSync(file) || !statSync(file).isFile()) return [];

    return [parseSkill(file, resolved, entry.name)];
  });
}

/** The skills bundled with the server, read-only for every account. */
export class DefaultSkills extends Context.Service<
  DefaultSkills,
  DefaultSkill[]
>()("crumble/skills/DefaultSkills") {
  /** Read from `root`; a missing directory that was configured `explicit`ly fails, a missing default warns. */
  static layer(root: string, explicit: boolean) {
    return Layer.effect(
      DefaultSkills,
      Effect.sync(() => {
        if (explicit && !existsSync(root))
          throw new Error(
            `Configured common skills directory does not exist: ${root}`,
          );

        if (!existsSync(root))
          console.warn(
            `Common skills directory not found; continuing with no common skills: ${root}`,
          );

        return loadDefaultSkills(root);
      }),
    );
  }
}
