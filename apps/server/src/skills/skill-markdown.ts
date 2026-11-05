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
