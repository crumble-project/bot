import {
  type ComponentProps,
  type ReactNode,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { Markdown, type MarkdownComponents } from "@tanstack/markdown/react";
import type * as Pele from "pele/lazy";
import { streamingMarkdownExtension } from "@tanstack/markdown/extensions/streaming";
import type { MarkdownExtension } from "@tanstack/markdown";

// Served unbundled by src/web-ui.ts (PELE_PREFIX), so each diagram type loads only when shown.
const PELE = "/ui-modules/pele/lazy.js";

const loadPele = (): Promise<typeof Pele> => import(PELE);

/** Renders Mermaid with Pele, loaded with each diagram type on first use; bad diagrams stay code. */
function Diagram({ source }: { source: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    let destroy: (() => void) | undefined;

    setFailed(false);
    void loadPele()
      .then(async ({ mountAsync }) => {
        if (stopped || !box.current) return;

        // Bot text is untrusted: no links or remote images, and Pele's size limits apply.
        const mounted = await mountAsync(box.current, source, {
          links: false,
          images: false,
          zoom: "auto",
          onError: () => setFailed(true),
        });

        if (mounted.error) setFailed(true);

        if (stopped) mounted.destroy();
        else destroy = () => mounted.destroy();
      })
      .catch(() => setFailed(true));

    return () => {
      stopped = true;
      destroy?.();
    };
  }, [source]);

  return failed ? (
    <pre>
      <code>{source}</code>
    </pre>
  ) : (
    <div ref={box} className="diagram" />
  );
}

const link = (props: ComponentProps<"a">) => (
  <a {...props} target="_blank" rel="noopener noreferrer" />
);

/** Finished replies draw Mermaid blocks; a streaming one keeps them as code until it completes. */
const components = {
  a: link,
  pre: (props: ComponentProps<"pre"> & { "data-lang"?: string }) => {
    if (props["data-lang"] !== "mermaid" || !isValidElement(props.children))
      return <pre {...props} />;

    // SAFETY: Outside streaming, TanStack Markdown passes a code block's text as one string child of `code`.
    const code = props.children.props as { children?: ReactNode };

    return <Diagram source={String(code.children ?? "")} />;
  },
} satisfies MarkdownComponents;

const streamingComponents = { a: link } satisfies MarkdownComponents;

const BARE_URL = /^https?:\/\/[^\s<>"]+/;
const ANGLE_URL = /^<(https?:\/\/[^\s<>"]+)>/;

/** Drops what GitHub drops from a bare URL's end: sentence punctuation, and closing brackets it didn't open. */
function trimUrl(url: string) {
  let end = url.length;

  for (;;) {
    const last = url[end - 1];

    if (last && ".,:;!?'*_~".includes(last)) end--;
    else if (
      last === ")" &&
      url.slice(0, end).split(")").length > url.slice(0, end).split("(").length
    )
      end--;
    else return url.slice(0, end);
  }
}

/** Bots often write bare links; TanStack Markdown only links `[text](url)`, so this links `https://…` and `<https://…>`. */
const autolinks: MarkdownExtension = {
  name: "autolinks",
  inlineParser: {
    markers: "h<",
    parse: ({ source, index, inLink }) => {
      if (inLink) return undefined;

      const rest = source.slice(index);
      const angle = ANGLE_URL.exec(rest);

      if (angle)
        return {
          node: {
            type: "link",
            href: angle[1]!,
            children: [{ type: "text", value: angle[1]! }],
          },
          length: angle[0].length,
        };

      // A URL starts a word, so "xhttps://" stays text.
      if (index > 0 && /[\p{L}\p{N}]/u.test(source[index - 1]!))
        return undefined;

      const bare = BARE_URL.exec(rest);
      const url = bare ? trimUrl(bare[0]) : "";

      return url.length > "https://".length
        ? {
            node: {
              type: "link",
              href: url,
              children: [{ type: "text", value: url }],
            },
            length: url.length,
          }
        : undefined;
    },
  },
};

const finished = [autolinks];

const streaming = [streamingMarkdownExtension(), autolinks];

/** Renders a bot's Markdown; `streaming` hides the unfinished tail of a reply in progress. */
export function Reply({
  source,
  streaming: partial = false,
}: {
  source: string;
  streaming?: boolean;
}) {
  return (
    <div className="markdown">
      <Markdown
        components={partial ? streamingComponents : components}
        extensions={partial ? streaming : finished}
      >
        {source}
      </Markdown>
    </div>
  );
}
