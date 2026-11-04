import { expect, test } from "bun:test";
import { costLine } from "./jobs";

const priced = { cost: { total: 1.5 } };

test("costLine sums every model", () => {
  expect(costLine({ models: { "a/one": priced, "b/two": priced } })).toBe(
    "$3.0000",
  );
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
