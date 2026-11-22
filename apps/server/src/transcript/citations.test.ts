import { describe, expect, test } from "bun:test";
import { projectCitations } from "./citations";
import type { TranscriptMessage } from "./transcript";

const message = (
  role: string,
  content: string,
  extra: Partial<TranscriptMessage> = {},
): TranscriptMessage => ({ id: "1", entryId: "1", role, content, ...extra });

describe("citation projection", () => {
  test("preserves literal parentheses and code, deduplicates sources, and leaves raw content intact", () => {
    const raw =
      "Keep () and [source](https://www.example.com/a) [source](https://www.example.com/a/) ` [source](https://www.example.com/a)`\n```\n[source](https://www.example.com/a)\n```";

    const reply = message("assistant", raw);
    projectCitations(
      [reply],
      [
        message("toolResult", "", {
          toolName: "web_search",
          toolDetails: [{ url: "https://www.example.com/a", title: "Example" }],
        }),
      ],
    );
    expect(reply.content).toBe(raw);
    expect(reply.presentation).toEqual({
      text: "Keep () and ` [source](https://www.example.com/a)`\n```\n[source](https://www.example.com/a)\n```",
      citations: [
        {
          href: "https://www.example.com/a",
          title: "Example",
          site: "example.com",
        },
      ],
    });
  });
  test("resets sources at a user message and uses only the new turn's sources", () => {
    const stale = message("assistant", "[source](https://example.com)");
    const reply = message("assistant", "([source](https://example.com))");
    projectCitations(
      [
        message("user", "next"),
        stale,
        message("toolResult", "", {
          toolName: "web_search",
          toolDetails: [{ url: "https://example.com", title: "New" }],
        }),
        reply,
      ],
      [
        message("toolResult", "", {
          toolName: "web_search",
          toolDetails: [{ url: "https://example.com", title: "Old" }],
        }),
      ],
    );
    expect(stale.presentation).toEqual({ text: stale.content, citations: [] });
    expect(reply.presentation).toEqual({
      text: "",
      citations: [
        { href: "https://example.com", title: "New", site: "example.com" },
      ],
    });
  });
});
