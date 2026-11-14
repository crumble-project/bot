import { expect, test } from "bun:test";
import { jobItems, projectJobPage } from "./job-history";
import { workingOf } from "./working";
import type { TranscriptMessage } from "../transcript/transcript";

const message = (overrides: Partial<TranscriptMessage>): TranscriptMessage => ({
  id: "a:1:0",
  entryId: "a:1",
  role: "assistant",
  content: "",
  ...overrides,
});

test("projects steps with results from a newer page", () => {
  const call = message({
    blocks: [
      {
        type: "toolCall",
        id: "c",
        name: "bash",
        arguments: { command: "pwd" },
      },
    ],
  });

  const result = message({
    id: "a:2:0",
    entryId: "a:2",
    role: "toolResult",
    toolCallId: "c",
    content: "failed",
    isError: true,
  });

  expect(jobItems([call], [result])).toEqual([
    {
      kind: "step",
      id: "c",
      tool: "bash",
      label: "Ran",
      icon: "terminal",
      subject: "pwd",
      result: { ...result, replyReferences: [] },
    },
  ]);
});

test("classifies running chat work", () => {
  const call = message({
    blocks: [{ type: "toolCall", id: "c", name: "web_search", arguments: {} }],
  });

  expect(workingOf("running", "hello", [call])).toBe("writing");
  expect(workingOf("running", "", [call])).toBe("searching");
  expect(
    workingOf("running", "", [message({ role: "toolResult", isError: true })]),
  ).toBe("struggling");
  expect(workingOf("failed", "", [])).toBe("failed");
});

test("correlates an older page with results in newer pages", async () => {
  const call = message({
    blocks: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }],
  });

  const result = message({
    id: "a:250:0",
    entryId: "a:250",
    role: "toolResult",
    toolCallId: "c",
    content: "done",
  });

  const reads: (string | undefined)[] = [];
  const page = { messages: [call], hasMore: false, oldestEntryId: "a:1" };

  const projected = await projectJobPage(page, "a:50", async (before) => {
    reads.push(before);

    return before === undefined
      ? { messages: [result], hasMore: true, oldestEntryId: "a:200" }
      : { messages: [], hasMore: true, oldestEntryId: "a:40" };
  });

  expect(reads).toEqual([undefined, "a:200"]);
  expect(projected.items[0]).toMatchObject({ kind: "step", result });
});
