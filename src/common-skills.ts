import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type CommonSkill = {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  path: string;
};

const MAX_SKILLS = 100;
const MAX_FILE_BYTES = 512 * 1024;

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

function parseSkill(
  file: string,
  root: string,
  directory: string,
): CommonSkill {
  const source = readFileSync(file, "utf8");

  if (Buffer.byteLength(source, "utf8") > MAX_FILE_BYTES)
    throw new Error(`Common skill is too large: ${file}`);
  let body = source.trim();
  let name = directory;
  let description: string | undefined;

  if (body.startsWith("---\n") || body.startsWith("---\r\n")) {
    const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

    if (!match) throw new Error(`Invalid common skill frontmatter: ${file}`);

    for (const line of match[1]!.split(/\r?\n/)) {
      const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);

      if (!field) continue;
      const value = unquote(field[2] ?? "");

      if (field[1] === "name" && value) name = value;

      if (field[1] === "description" && value) description = value;
    }

    body = body.slice(match[0].length).trim();
  }

  if (!body) throw new Error(`Common skill has no instructions: ${file}`);
  const path = relative(root, file);

  return { id: `common:${path}`, name, description, instructions: body, path };
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
