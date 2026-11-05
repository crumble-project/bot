export type Sources = ReadonlyMap<string, string>;

export function sourceKey(href: string) {
  try {
    const url = new URL(href);

    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

    return `${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return undefined;
  }
}

// A citation: a Markdown link labeled "source", whose URL may hold one pair of parentheses.
const CITATION =
  /\[sources?\]\((https?:\/\/[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/gi;

// A private-use character marks where a chip was; bot text never contains it.
const SLOT = String.fromCodePoint(0xe000);

const SEPARATOR = new RegExp(
  `${SLOT}[ \\t]*(?:,|;|&|and)[ \\t]*(?=${SLOT})`,
  "g",
);

const LEFTOVER = new RegExp(`[ \\t]*${SLOT}`, "g");

const EMPTY_PARENS = /[ \t]*\((?:\s*sources?:?)?\s*\)/gi;

export type SourceChip = { href: string; title: string };

function takeSources(
  prose: string,
  sources: Sources,
  chips: Map<string, SourceChip>,
) {
  return prose
    .replace(CITATION, (link, href: string) => {
      const key = sourceKey(href);
      const title = key === undefined ? undefined : sources.get(key);

      if (key === undefined || title === undefined) return link;

      if (!chips.has(key)) chips.set(key, { href, title });

      return SLOT;
    })
    .replace(SEPARATOR, SLOT)
    .replace(LEFTOVER, "")
    .replace(EMPTY_PARENS, "");
}

export function splitSources(markdown: string, sources: Sources) {
  const chips = new Map<string, SourceChip>();
  let fenced = false;

  const text = markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;

        return line;
      }

      return fenced
        ? line
        : line
            .split(/(`[^`]*`)/)
            .map((part) =>
              part.startsWith("`") ? part : takeSources(part, sources, chips),
            )
            .join("");
    })
    .join("\n");

  return { text, chips: [...chips.values()] };
}
