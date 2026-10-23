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

const streaming = [streamingMarkdownExtension()];

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
        extensions={partial ? streaming : undefined}
      >
        {source}
      </Markdown>
    </div>
  );
}
