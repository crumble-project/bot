import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  MAX_SKILL_DOCUMENTS,
  skillDocumentInput,
  type SkillDocument,
} from "../shared/domain";

export type CommonSkill = {
  id: string;
  name: string;
  description?: string | undefined;
  instructions: string;
  /** Reference documents from the skill's `references` directory, by relative path. */
  documents: SkillDocument[];
  path: string;
};

const MAX_SKILLS = 100;
const MAX_FILE_BYTES = 512 * 1024;

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

function unquote(value: string) {
  const trimmed = value.trim();

  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  )
    return trimmed.slice(1, -1);

  return trimmed;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const BLOCK_SCALAR = /^[|>][+-]?$/;

/** The indented lines after `start` of a `key: >` or `key: |` value, folded into one line. */
function blockValue(lines: string[], start: number) {
  const rest = lines.slice(start);
  const end = rest.findIndex((line) => line.trim() && !/^\s/.test(line));

  return (end === -1 ? rest : rest.slice(0, end))
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function frontmatterFields(lines: string[]) {
  const fields = new Map<string, string>();

  for (const [index, line] of lines.entries()) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);

    if (!field) continue;
    const raw = (field[2] ?? "").trim();

    const value = BLOCK_SCALAR.test(raw)
      ? blockValue(lines, index + 1)
      : unquote(raw);

    if (value) fields.set(field[1]!, value);
  }

  return fields;
}

/** A SKILL.md's frontmatter fields and the instructions after them; null when the frontmatter never closes. */
export function parseSkillMarkdown(source: string) {
  const trimmed = source.trim();

  if (!trimmed.startsWith("---\n") && !trimmed.startsWith("---\r\n"))
    return { fields: new Map<string, string>(), body: trimmed };

  const match = trimmed.match(FRONTMATTER);

  if (!match) return null;

  return {
    fields: frontmatterFields(match[1]!.split(/\r?\n/)),
    body: trimmed.slice(match[0].length).trim(),
  };
}

function parseSkill(
  file: string,
  root: string,
  directory: string,
): CommonSkill {
  const source = readFileSync(file, "utf8");

  if (Buffer.byteLength(source, "utf8") > MAX_FILE_BYTES)
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
export function loadCommonSkills(root: string): CommonSkill[] {
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
export class CommonSkills extends Context.Service<
  CommonSkills,
  CommonSkill[]
>()("crumble/skills/CommonSkills") {
  /** Read from `root`; a missing directory that was configured `explicit`ly fails, a missing default warns. */
  static layer(root: string, explicit: boolean) {
    return Layer.effect(
      CommonSkills,
      Effect.sync(() => {
        if (explicit && !existsSync(root))
          throw new Error(
            `Configured common skills directory does not exist: ${root}`,
          );

        if (!existsSync(root))
          console.warn(
            `Common skills directory not found; continuing with no common skills: ${root}`,
          );

        return loadCommonSkills(root);
      }),
    );
  }
}
