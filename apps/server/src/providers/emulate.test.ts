import { expect, test } from "bun:test";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { emulateProvider } from "./emulate";
import {
  EMULATE_MODEL_IDS,
  emulateDirectoriesOverlap,
} from "./emulate-profile";
import { meliousProvider } from "./melious";
import { accountModels } from "./providers";

test("local data rejects filesystem roots, ordinary data and overlapping directories", () => {
  for (const path of [
    "/",
    "/repository",
    "/repository/data",
    "/repository/data/nested",
  ]) {
    expect(emulateDirectoriesOverlap(path, "/repository/data")).toBe(true);
  }
  for (const path of [
    "/isolated/data",
    "/repository/data-other",
    "/repository/.cache/emulate/data",
  ]) {
    expect(emulateDirectoriesOverlap(path, "/repository/data")).toBe(false);
  }
});

const baseUrl = "http://127.0.0.1:1/v1";
const forbidden = async (): Promise<never> => {
  throw new Error("The local catalog must never access saved credentials");
};
const credentials: CredentialStore = {
  read: forbidden,
  list: forbidden,
  modify: forbidden,
  delete: forbidden,
};

test("local accounts expose only configured Emulate models without reading credentials", async () => {
  for (const store of [undefined, credentials]) {
    const models = accountModels(store, [{ provider: meliousProvider() }], {
      baseUrl,
    });

    expect(models.getProviders().map((provider) => provider.id)).toEqual([
      "emulate",
    ]);
    expect(models.getModels().map((model) => model.id)).toEqual([
      ...EMULATE_MODEL_IDS,
    ]);
    expect((await models.getAvailable()).map((model) => model.id)).toEqual([
      ...EMULATE_MODEL_IDS,
    ]);
    expect(await models.checkAuth("emulate")).toEqual({
      type: "api_key",
      source: "emulate-local",
    });
    expect(await models.getAuth("emulate")).toEqual({
      auth: { apiKey: "emulate-local" },
      source: "emulate-local",
    });
    expect(await models.getAuth("melious")).toBeUndefined();
    expect(await models.getAuth("openai")).toBeUndefined();
  }
});

test("each local catalog uses its current emulator endpoint", () => {
  for (const url of [baseUrl, "http://127.0.0.1:2/v1"]) {
    const models = accountModels(credentials, [], { baseUrl: url });

    expect(models.getProvider("emulate")?.baseUrl).toBe(url);
    expect(models.getModels().map((model) => model.baseUrl)).toEqual(
      EMULATE_MODEL_IDS.map(() => url),
    );
  }
});

test("Emulate rejects remote, credential-bearing and ambiguous endpoints", () => {
  for (const url of [
    "https://127.0.0.1:1/v1",
    "http://example.test:1/v1",
    "http://localhost:1/v1",
    "http://0.0.0.0:1/v1",
    "http://[::1]:1/v1",
    "http://user:password@127.0.0.1:1/v1",
    "http://127.0.0.1/v1",
    "http://127.0.0.1:0/v1",
    "http://127.0.0.1:65536/v1",
    `${baseUrl}/`,
    `${baseUrl}?key=secret`,
    `${baseUrl}#fragment`,
  ]) {
    expect(() => emulateProvider(url)).toThrow();
  }
});
