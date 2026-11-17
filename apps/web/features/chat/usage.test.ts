import { expect, test } from "bun:test";
import { usageDocument } from "@crumble/server/contract/tool-details";
import { costLine, formatTokens, usageRows } from "./usage";

const priced = { totalTokens: 1200, cost: { total: 1.5 } };

test("costLine sums every model", () => {
  expect(costLine({ models: { "a/one": priced, "b/two": priced } })).toBe(
    "$3.0000",
  );
});

test("costLine counts tools such as vision and intent checks", () => {
  expect(
    costLine({ models: { "a/one": priced }, tools: { intent: priced } }),
  ).toBe("$3.0000");
});

test("costLine is empty for a provider that reports no cost", () => {
  expect(
    costLine({ models: { "claude-code/one": { cost: { total: 0 } } } }),
  ).toBeNull();
});

test("costLine is empty before the first request", () => {
  expect(costLine(undefined)).toBeNull();
  expect(costLine({ models: {} })).toBeNull();
});

test("usageRows lists models, then tools, with tokens and cost", () => {
  expect(
    usageRows({
      tools: { vision: { totalTokens: 300 } },
      models: { "a/one": priced },
    }),
  ).toEqual([
    { kind: "model", name: "a/one", tokens: 1200, cost: 1.5 },
    { kind: "tool", name: "vision", tokens: 300, cost: 0 },
  ]);
});

test("a document that doesn't parse has no rows", () => {
  expect(usageRows(usageDocument.safeParse("nonsense").data)).toEqual([]);
});

test("formatTokens abbreviates large counts", () => {
  expect(formatTokens(1)).toBe("1 token");
  expect(formatTokens(950)).toBe("950 tokens");
  expect(formatTokens(12_345)).toBe("12K tokens");
});
