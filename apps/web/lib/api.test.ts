import { expect, spyOn, test } from "bun:test";
import { apiBlob } from "./api";

test("attachment fetch returns a blob without creating a cached object URL", async () => {
  const originalFetch = globalThis.fetch;

  const createObjectURL = spyOn(URL, "createObjectURL").mockReturnValue(
    "blob:test",
  );

  globalThis.fetch = Object.assign(
    async () => new Response("image"),
    originalFetch,
  );

  try {
    const result = await apiBlob("/attachment");
    expect(result).toBeInstanceOf(Blob);
    expect(createObjectURL).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
    createObjectURL.mockRestore();
  }
});
