import { isValidElement, useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { Markdown } from "@tanstack/markdown/react";
import type { MarkdownComponents } from "@tanstack/markdown/react";
import { PELE_PREFIX } from "@crumble/server/contract/ui-modules";
import type { MarkdownExtension } from "@tanstack/markdown";
import type { z } from "zod";
import type { citation } from "@crumble/server/contract/api-responses";
import type { mountAsync } from "pele/lazy";

const PELE = `${PELE_PREFIX}/lazy.js`;

type Pele = { mountAsync: typeof mountAsync };

const loadPele = (): Promise<Pele> => import(PELE);

function Diagram({ source }: { source: string }) {
  const box = useRef<HTMLDivElement>(null);

  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = failedSource === source;

  useEffect(() => {
    let stopped = false;
    let destroy: (() => void) | undefined;

    const fail = () => {
      if (!stopped) {
        setFailedSource(source);
      }
    };

    void loadPele()
      .then(async ({ mountAsync }) => {
        if (stopped || !box.current) {
          return;
        }

        const mounted = await mountAsync(box.current, source, {
          links: false,
          images: false,
          zoom: "auto",
          onError: fail,
        });

        if (stopped) {
          mounted.destroy();

          return;
        }

        if (mounted.error) {
          setFailedSource(source);
        }

        destroy = () => mounted.destroy();
      })
      .catch(fail);

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
    if (
      props["data-lang"] !== "mermaid" ||
      !isValidElement<{ children?: string }>(props.children)
    ) {
      return <pre {...props} />;
    }

    return <Diagram source={props.children.props.children ?? ""} />;
  },
} satisfies MarkdownComponents;

const BARE_URL = /^https?:\/\/[^\s<>"]+/;
const ANGLE_URL = /^<(https?:\/\/[^\s<>"]+)>/;

function trimUrl(url: string) {
  let end = url.length;

  for (;;) {
    const last = url[end - 1];

    if (last && ".,:;!?'*_~".includes(last)) {
      end--;
    } else if (
      last === ")" &&
      url.slice(0, end).split(")").length > url.slice(0, end).split("(").length
    ) {
      end--;
    } else {
      return url.slice(0, end);
    }
  }
}

const autolinks: MarkdownExtension = {
  name: "autolinks",
  inlineParser: {
    markers: "h<",
    parse: ({ source, index, inLink }) => {
      if (inLink) {
        return;
      }

      const rest = source.slice(index);
      const angle = ANGLE_URL.exec(rest);

      if (angle) {
        const [, href] = angle;

        if (href) {
          return {
            node: {
              type: "link",
              href,
              children: [{ type: "text", value: href }],
            },
            length: angle[0].length,
          };
        }
      }

      const previous = source[index - 1];

      if (index > 0 && previous && /[\p{L}\p{N}]/u.test(previous)) {
        return;
      }

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
  citations?: Array<z.infer<typeof citation>> | undefined;
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
