import { Markdown, type MarkdownComponents } from "@tanstack/markdown/react";
import { streamingMarkdownExtension } from "@tanstack/markdown/extensions/streaming";

const components = {
  a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
} satisfies MarkdownComponents;

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
        components={components}
        extensions={partial ? streaming : undefined}
      >
        {source}
      </Markdown>
    </div>
  );
}
