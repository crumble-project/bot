import { expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { previewReasoning } from "./providers-api";

const model: Model<"openai-completions"> = {
  id: "example",
  name: "Example",
  api: "openai-completions",
  provider: "example",
  baseUrl: "https://example.invalid",
  input: ["text"],
  reasoning: false,
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test("resolves options and effective level for a model without reasoning", () => {
  expect(previewReasoning(model, "high")).toEqual({
    options: [{ value: "off", label: "Off" }],
    effectiveLevel: "off",
  });
});

test("preserves the level and exposes all options for an unknown model", () => {
  const result = previewReasoning(undefined, "max");
  expect(result.effectiveLevel).toBe("max");
  expect(result.options.map((option) => option.value)).toEqual([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});
