import { describe, expect, test } from "bun:test";
import { mentionedMembers } from "../src/group-mentions";

const members = [
  { id: "ada", name: "Ada" },
  { id: "lovelace", name: "Ada Lovelace" },
  { id: "grace", name: "Grace" },
];

describe("mentionedMembers", () => {
  test("matches names case-insensitively in first-mention order", () => {
    expect(mentionedMembers("@grace and @ADA, over to you", members)).toEqual([
      "grace",
      "ada",
    ]);
  });

  test("prefers the longest matching name", () => {
    expect(mentionedMembers("@Ada Lovelace please check", members)).toEqual([
      "lovelace",
    ]);
  });

  test("needs a word boundary after the name", () => {
    expect(mentionedMembers("@Adam and @Graceful", members)).toEqual([]);
    expect(mentionedMembers("Thanks @Grace!", members)).toEqual(["grace"]);
  });

  test("ignores email addresses, repeats, and the sender", () => {
    expect(mentionedMembers("mail ada@example.com", members)).toEqual([]);
    expect(mentionedMembers("@Grace @Grace @Ada", members, "ada")).toEqual([
      "grace",
    ]);
  });
});
