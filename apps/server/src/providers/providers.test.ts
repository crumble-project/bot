import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type {
  Credential,
  Model,
  ModelsPublication,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { meliousProvider } from "./providers";

const API_KEY: Credential = { type: "api_key", key: "melious-key" };

const meliousLarge: Model<"openai-completions"> = {
  id: "melious-large",
  name: "Melious Large",
  api: "openai-completions",
  provider: "melious",
  baseUrl: "https://api.melious.ai/v1",
  input: ["text"],
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 16384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const refreshCatalog = async (
  credential: Credential | undefined,
  baseUrl?: string,
) => {
  const provider = meliousProvider();
  const publications: ModelsPublication[] = [];

  const context: RefreshModelsContext = {
    ...(credential && { credential }),
    publish: async (publication) => {
      publications.push(publication);
      publication.update?.();

      return true;
    },
    allowNetwork: true,
    signal: new AbortController().signal,
    ...(baseUrl !== undefined && { baseUrl }),
  };

  await provider.refreshModels?.(context);

  return { publications, models: provider.getModels() };
};

afterEach(() => {
  mock.restore();
});

describe("Melious catalog", () => {
  test("offers no models until the account saves a key", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");

    expect(await refreshCatalog(undefined)).toMatchObject({ models: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("ignores OAuth credentials, which carry no Melious key", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");

    const oauth: Credential = {
      type: "oauth",
      refresh: "refresh",
      access: "access",
      expires: 0,
    };

    expect(await refreshCatalog(oauth)).toMatchObject({ models: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("turns the account's catalog into OpenAI-compatible models", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");

    fetchSpy.mockResolvedValueOnce(
      Response.json({
        data: [
          { id: "melious-large", name: "Melious Large" },
          { name: "Melious without an id" },
          { id: "melious-small" },
        ],
      }),
    );

    const { models, publications } = await refreshCatalog(API_KEY);
    const call = fetchSpy.mock.calls[0];

    expect(call?.[0]).toBe("https://api.melious.ai/v1/models");
    expect(call?.[1]?.headers).toEqual({ authorization: "Bearer melious-key" });
    expect(models).toEqual([
      meliousLarge,
      { ...meliousLarge, id: "melious-small", name: "melious-small" },
    ]);
    expect(publications).toHaveLength(1);
  });

  test("loads from a configured base URL and stamps it on every model", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ data: [{ id: "melious-large" }] }),
    );

    const { models } = await refreshCatalog(
      API_KEY,
      "https://proxy.example/v1",
    );

    expect(models.map((model) => model.baseUrl)).toEqual([
      "https://proxy.example/v1",
    ]);
  });

  test("surfaces a catalog failure with its status", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 500 }),
    );

    await expect(refreshCatalog(API_KEY)).rejects.toThrow(
      "Melious model list failed with 500",
    );
  });

  test("treats a catalog without a data list as empty", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({}));

    expect(await refreshCatalog(API_KEY)).toMatchObject({ models: [] });
  });
});
