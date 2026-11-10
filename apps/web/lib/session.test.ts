import { expect, test } from "bun:test";
import { connectPath, returnPath } from "./session";

test("sign-in returns only to a path on this site", () => {
  expect(returnPath("/settings/providers")).toBe("/settings/providers");
  expect(returnPath("/bots/a1?tab=x#y")).toBe("/bots/a1?tab=x#y");

  for (const next of [
    undefined,
    null,
    "",
    "settings",
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/connect",
    "/connect?next=/x",
  ])
    expect(returnPath(next)).toBe("/");
});

test("the sign-in page carries where to return", () => {
  expect(connectPath("/")).toBe("/connect");
  expect(connectPath("/settings/providers")).toBe(
    "/connect?next=%2Fsettings%2Fproviders",
  );
  expect(connectPath("//evil.example")).toBe("/connect");
});
