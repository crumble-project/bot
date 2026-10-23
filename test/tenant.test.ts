import { afterEach, expect, test } from "bun:test";
import { providerModels } from "../src/providers";

const original = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (original === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = original;
});

test("tenant provider models do not resolve ambient host credentials", async () => {
  process.env.OPENAI_API_KEY = "host-secret";

  const models = providerModels(undefined, [], { allowAmbientEnv: false });

  expect(await models.getAuth("openai")).toBeUndefined();
});
