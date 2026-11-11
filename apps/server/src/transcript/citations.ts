import { webPagesDetails } from "../contract/tool-details";
import { WEB_EXTRACT_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "../contract/tools";
import type { TranscriptMessage } from "./transcript";

function sourceKey(href: string) {
  try {
    const url = new URL(href);

    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

    return `${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return undefined;
  }
}

const citation =
  /\[sources?\]\((https?:\/\/[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/gi;

const slot = String.fromCodePoint(0xe000);

const separators = new RegExp(
  `${slot}[ \\t]*(?:,|;|&|and)[ \\t]*(?=${slot})`,
  "g",
);

const wrappers = new RegExp(
  `[ \\t]*\\((?:\\s*sources?:?)?\\s*${slot}(?:\\s*${slot})*\\s*\\)`,
  "gi",
);

const remaining = new RegExp(`[ \\t]*${slot}`, "g");

type Sources = Map<string, string>;

type Citation = { href: string; title: string; site: string };

function addSources(sources: Sources, pages: { url: string; title: string }[]) {
  for (const page of pages) {
    const key = sourceKey(page.url);

    if (key) sources.set(key, page.title);
  }
}

function collectSources(message: TranscriptMessage, sources: Sources) {
  if (
    message.role !== "toolResult" ||
    message.isError ||
    (message.toolName !== WEB_SEARCH_TOOL_NAME &&
      message.toolName !== WEB_EXTRACT_TOOL_NAME)
  )
    return;

  const pages = webPagesDetails.safeParse(message.toolDetails);

  if (pages.success)
    addSources(
      sources,
      pages.data.filter((page) => "title" in page),
    );
}

function replaceCitations(
  part: string,
  sources: Sources,
  chips: Map<string, Citation>,
) {
  return part
    .replace(citation, (link, href: string) => {
      const key = sourceKey(href);
      const title = key === undefined ? undefined : sources.get(key);

      if (key === undefined || title === undefined) return link;

      if (!chips.has(key))
        chips.set(key, {
          href,
          title,
          site: new URL(href).hostname.replace(/^www\./, ""),
        });

      return slot;
    })
    .replace(separators, slot)
    .replace(wrappers, "")
    .replace(remaining, "");
}

function present(message: TranscriptMessage, sources: Sources) {
  const available = message.sources ? new Map<string, string>() : sources;

  if (message.sources) addSources(available, message.sources);

  const chips = new Map<string, Citation>();
  let fenced = false;

  const text = message.content
    .split("\n")
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;

        return line;
      }

      if (fenced) return line;

      return line
        .split(/(`[^`]*`)/)
        .map((part) =>
          part.startsWith("`")
            ? part
            : replaceCitations(part, available, chips),
        )
        .join("");
    })
    .join("\n");

  message.presentation = { text, citations: [...chips.values()] };
}

export function projectCitations(
  messages: TranscriptMessage[],
  context: TranscriptMessage[] = [],
) {
  let sources: Sources = new Map();

  for (const message of [...context, ...messages]) {
    if (message.role === "user") sources = new Map();

    collectSources(message, sources);

    if (message.role === "assistant") present(message, sources);
  }
}
