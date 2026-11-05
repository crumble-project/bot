import { expect, test } from "bun:test";
import type { AnyModel } from "@earendil-works/pi-ai";
import { accountModels } from "../providers/providers";
import { decide } from "./intent-check";
import { decidesEnter, inIntentBar, judgeUsage } from "./intent-judge";

const catalog = accountModels(undefined, []);

const classifier = (provider: string, id: string) => {
  const model = catalog.getModelOfType("classifier", provider, id);

  if (!model) throw new Error(`${provider}/${id} is not in pi-ai's catalog`);

  return model;
};

test("Jev's bar sits between the eval's asked and unasked actions; an unevaluated classifier must be surer", () => {
  const held = (model: AnyModel, inIntent: number) =>
    decide(true, {
      irreversible: 0.96,
      inIntent,
      inIntentBar: inIntentBar(model),
    }).held;

  const jev = classifier("typesafe", "jev-latest");

  expect(held(jev, 0.55)).toBe(false);
  expect(held(jev, 0.42)).toBe(true);
  expect(held(classifier("openai", "gpt-6-luna"), 0.55)).toBe(true);
});

test("only GPT-6 Luna decides Enter: the intent eval showed Jev missing what Enter can commit", () => {
  expect(decidesEnter(classifier("openai", "gpt-6-luna"))).toBe(true);
  expect(decidesEnter(classifier("typesafe", "jev-latest"))).toBe(false);
});

test("Jev's spend is priced at TypeSafe's rate, which pi-ai's catalog lacks", () => {
  const tokens = {
    input: 1_000_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1_000_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  const { cost } = judgeUsage(classifier("typesafe", "jev-latest"), tokens);

  expect(cost.input).toBeGreaterThan(0);
  expect(cost.total).toBe(cost.input);

  expect(judgeUsage(classifier("openai", "gpt-6-luna"), tokens)).toBe(tokens);
});
