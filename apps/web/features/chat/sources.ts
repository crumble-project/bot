import type { Message } from "@/lib/api";
import type {
  WebPage,
  WebSearchResult,
} from "@crumble/server/web-search/provider";

/** Pages a reply may cite, keyed by `sourceKey` of their URL, with their titles. */
export type Sources = ReadonlyMap<string, string>;

/** Ignores the fragment, a trailing slash, and the host's case, so a cited link matches the page that was read. */
export function sourceKey(href: string) {
  try {
    const url = new URL(href);

    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

    return `${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return undefined;
  }
}

function pagesOf(message: Message) {
  if (
    message.role !== "toolResult" ||
    message.isError ||
    (message.toolName !== "web_search" && message.toolName !== "web_extract") ||
    !Array.isArray(message.toolDetails)
  )
    return [];

  // SAFETY: web_search stores WebSearchResult[] and web_extract stores WebPage[] in toolDetails.
  const pages = message.toolDetails as (WebSearchResult | WebPage)[];

  return pages.flatMap((page) => ("error" in page ? [] : [page]));
}

/** A group message's sources, which the server stores with the message. */
export function groupSourcesOf(message: Message): Sources | undefined {
  if (!message.sources?.length) return undefined;

  return new Map(
    message.sources.flatMap(({ url, title }) => {
      const key = sourceKey(url);

      return key ? [[key, title] as const] : [];
    }),
  );
}

/** For each bot reply, the pages its turn searched or read; a turn starts at each message to the bot. */
export function sourcesOf(messages: Message[]) {
  const replies = new Map<string, Sources>();
  let turn = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "user") turn = new Map();

    for (const page of pagesOf(message)) {
      const key = sourceKey(page.url);

      if (key) turn.set(key, page.title);
    }

    if (message.role === "assistant" && turn.size > 0)
      replies.set(message.id, new Map(turn));
  }

  return replies;
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

/** Takes the reply's citations of pages its turn read out of its text, outside code, so they show once as chips after it. */
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
