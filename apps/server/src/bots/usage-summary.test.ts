import { expect, test } from "bun:test";
import type { UsageState } from "@earendil-works/pi-durable";
import { usageSummary } from "./usage-summary";

const usage = (totalTokens: number, cost: number) => ({
  input: totalTokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

test("sums each model and tool across bots, most tokens first", () => {
  const first: UsageState = {
    models: {
      "anthropic/claude-sonnet-5-5": usage(100, 0.5),
      "openai/gpt-6": usage(10, 0.25),
    },
    tools: { vision: usage(5, 0.01) },
  };

  const second: UsageState = {
    models: { "openai/gpt-6": usage(200, 1) },
    tools: {},
  };

  expect(usageSummary([first, second])).toEqual({
    models: [
      { provider: "openai", model: "gpt-6", tokens: 210, cost: 1.25 },
      {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        tokens: 100,
        cost: 0.5,
      },
    ],
    tools: [{ name: "vision", tokens: 5, cost: 0.01 }],
  });
});

test("splits a model key at its first slash", () => {
  const state: UsageState = {
    models: { "openrouter/meta/llama-5": usage(1, 0) },
    tools: {},
  };

  expect(usageSummary([state]).models).toEqual([
    { provider: "openrouter", model: "meta/llama-5", tokens: 1, cost: 0 },
  ]);
});

test("returns empty lists without usage", () => {
  expect(usageSummary([])).toEqual({ models: [], tools: [] });
});
