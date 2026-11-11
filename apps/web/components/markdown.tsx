import {
  type ComponentProps,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { Markdown, type MarkdownComponents } from "@tanstack/markdown/react";
import { PELE_PREFIX } from "@crumble/server/contract/ui-modules";
import type * as Pele from "pele/lazy";
import type { MarkdownExtension } from "@tanstack/markdown";
import type { z } from "zod";
import type { citation } from "@crumble/server/contract/api-responses";

const PELE = `${PELE_PREFIX}/lazy.js`;

// The server hosts this module at run time, so the bundler must not resolve it.
// react-doctor-disable-next-line react-doctor/no-dynamic-import-path
const loadPele = (): Promise<typeof Pele> => import(PELE);

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
          onError: () => {
            if (!stopped) setFailed(true);
          },
        });

        if (stopped) {
          mounted.destroy();

          return;
        }

        if (mounted.error) setFailed(true);
        destroy = () => mounted.destroy();
      })
      .catch(() => {
        if (!stopped) setFailed(true);
      });

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

const components = {
  a: link,
  pre: (props: ComponentProps<"pre"> & { "data-lang"?: string }) => {
    if (props["data-lang"] !== "mermaid" || !isValidElement(props.children))
      return <pre {...props} />;

    // SAFETY: TanStack Markdown passes a code block's text as one string child of `code`.
    const code = props.children.props as { children?: string };

    return <Diagram source={code.children ?? ""} />;
  },
} satisfies MarkdownComponents;

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

const extensions = [autolinks];

export function Reply({
  source,
  citations = [],
}: {
  source: string;
  citations?: z.infer<typeof citation>[] | undefined;
}) {
  return (
    <div className="markdown">
      <Markdown components={components} extensions={extensions}>
        {source}
      </Markdown>
      {citations.length > 0 && (
        <div className="source-chips">
          {citations.map((chip) => (
            <a
              key={chip.href}
              href={chip.href}
              title={chip.title || chip.href}
              target="_blank"
              rel="noopener noreferrer"
              className="source-chip"
            >
              {chip.site}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
