import { expect, test } from "bun:test";
import { providerModels } from "../providers/providers";
import { decide } from "./intent-check";
import { inIntentBar, judgeUsage } from "./intent-judge";

const catalog = providerModels(undefined, [], { allowAmbientEnv: false });

const classifier = (provider: string, id: string) => {
  const model = catalog.getModelOfType("classifier", provider, id);

  if (!model) throw new Error(`${provider}/${id} is not in pi-ai's catalog`);

  return model;
};

test("Jev's in-intent bar comes from the intent eval; an unevaluated classifier must be sure", () => {
  expect(inIntentBar(classifier("typesafe", "jev-latest"))).toBe(0.5);
  expect(inIntentBar(classifier("openai", "gpt-6-luna"))).toBe(0.9);
});

test("an asked-for commit point runs at Jev's bar and is held at the default one", () => {
  // Jev's lowest in-intent answer for an action the owner asked for in the eval.
  const answer = { irreversible: 0.96, inIntent: 0.55 };

  expect(decide(true, { ...answer, inIntentBar: 0.5 }).held).toBe(false);
  expect(decide(true, { ...answer, inIntentBar: 0.9 }).held).toBe(true);
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

  expect(
    judgeUsage(classifier("typesafe", "jev-latest"), tokens).cost,
  ).toMatchObject({
    input: 0.042,
    total: 0.042,
  });

  // A catalog price is kept as pi-ai computed it.
  expect(judgeUsage(classifier("openai", "gpt-6-luna"), tokens)).toBe(tokens);
});
