import { describe, expect, test } from "bun:test";
import { MARK_QUESTION_TOOL_NAME } from "../contract/tools";
import { ASSISTANT_ENTRY, MESSAGE_ENTRY } from "./entries";
import { chatQuestionOpen } from "./chat-question";
import type { TranscriptMessage } from "./transcript";

let sequence = 0;

const message = (
  fields: Omit<TranscriptMessage, "id" | "entryId" | "content">,
): TranscriptMessage => {
  sequence += 1;

  return {
    id: `m${sequence}`,
    entryId: `e${sequence}`,
    content: "",
    ...fields,
  };
};

const owner = () =>
  message({ kind: MESSAGE_ENTRY, role: "user", origin: { kind: "owner" } });

const plainOwner = () => message({ kind: MESSAGE_ENTRY, role: "user" });

const automation = () =>
  message({
    kind: MESSAGE_ENTRY,
    role: "user",
    origin: { kind: "task", name: "Inbox check" },
  });

const fromBot = () =>
  message({
    kind: MESSAGE_ENTRY,
    role: "user",
    origin: { kind: "bot", name: "Helper", agentId: "other" },
  });

const reply = (text: string) =>
  message({
    kind: ASSISTANT_ENTRY,
    role: "assistant",
    blocks: [{ type: "text", text }],
  });

const mark = (isError = false, toolCallId = "call-1") =>
  message({
    kind: "pi.tool-result",
    role: "toolResult",
    toolName: MARK_QUESTION_TOOL_NAME,
    toolCallId,
    isError,
  });

const markCall = (text?: string, id = "call-1") =>
  message({
    kind: ASSISTANT_ENTRY,
    role: "assistant",
    blocks: [
      ...(text ? [{ type: "text" as const, text }] : []),
      {
        type: "toolCall" as const,
        id,
        name: MARK_QUESTION_TOOL_NAME,
        arguments: {},
      },
    ],
  });

const open = (messages: Array<TranscriptMessage>, answeringOwner = false) =>
  chatQuestionOpen(messages, answeringOwner);

describe("chatQuestionOpen", () => {
  test("is open once the bot marked a question and wrote it", () => {
    expect(open([owner(), mark(), reply("Which database?")])).toBe(true);
    expect(open([plainOwner(), mark(), reply("Which database?")])).toBe(true);
  });

  test("needs the mark and a written reply after it", () => {
    expect(open([owner(), reply("Which database?")])).toBe(false);
    expect(open([owner(), mark()])).toBe(false);
    expect(open([owner(), reply("Which database?"), mark()])).toBe(false);
    expect(open([owner(), mark(), reply("   ")])).toBe(false);
  });

  test("is open when the question is written in the message that marks it", () => {
    expect(open([owner(), markCall("Which database?"), mark()])).toBe(true);
    expect(open([owner(), markCall(), mark()])).toBe(false);
    expect(open([owner(), reply("Let me check."), markCall(), mark()])).toBe(
      false,
    );
    expect(
      open([
        owner(),
        reply("Let me check."),
        markCall(),
        mark(),
        reply("Which?"),
      ]),
    ).toBe(true);
    expect(open([owner(), markCall("Which database?", "other"), mark()])).toBe(
      false,
    );
    expect(open([owner(), markCall("Which database?"), mark(true)])).toBe(
      false,
    );
  });

  test("ignores a mark that failed or was declined", () => {
    expect(open([owner(), mark(true), reply("Which database?")])).toBe(false);
  });

  test("is closed by the next owner message, not by anything else", () => {
    const asked = [owner(), mark(), reply("Which database?")];

    expect(open([...asked, owner()])).toBe(false);
    expect(open([...asked, plainOwner(), reply("Postgres it is.")])).toBe(
      false,
    );
    expect(open([...asked, automation(), reply("Inbox is empty.")])).toBe(true);
    expect(open([...asked, fromBot(), reply("Noted.")])).toBe(true);
    expect(open([...asked, reply("Still waiting.")])).toBe(true);
  });

  test("ignores a question from before the latest owner message", () => {
    expect(
      open([owner(), mark(), reply("Which?"), owner(), reply("Done.")]),
    ).toBe(false);
  });

  test("is closed while a turn answers the owner", () => {
    expect(open([owner(), mark(), reply("Which database?")], true)).toBe(false);
  });

  test("is closed in an empty chat", () => {
    expect(open([])).toBe(false);
  });
});
