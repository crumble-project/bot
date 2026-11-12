import { describe, expect, test } from "bun:test";
import { extractPdfText, samplePdfRss } from "./pdf-text";

const fixture = async (name: string) =>
  new Uint8Array(
    await Bun.file(
      new URL(`../../test/fixtures/${name}.pdf`, import.meta.url),
    ).arrayBuffer(),
  );

describe("extractPdfText", () => {
  test("extracts text from a PDF", async () => {
    const result = await extractPdfText(await fixture("text"), {
      ms: 5000,
      memoryMib: 512,
    });

    expect(result.kind).toBe("text");

    if (result.kind === "text")
      expect(result.text).toContain("Crumble library fixture");
  });

  test("returns none for a scan", async () => {
    expect(
      await extractPdfText(await fixture("scan"), { ms: 5000, memoryMib: 512 }),
    ).toEqual({ kind: "none" });
  });

  test("times out on a pathological PDF", async () => {
    const start = performance.now();

    const result = await extractPdfText(await fixture("pathological"), {
      ms: 1000,
      memoryMib: 512,
    });

    expect(result).toEqual({
      kind: "failed",
      reason: "PDF extraction timed out",
    });
    expect(performance.now() - start).toBeLessThan(2000);
  });

  test("reports unavailable RSS for a nonexistent process", async () => {
    expect(await samplePdfRss(2147483647)).toBeNull();
    expect(await samplePdfRss(process.pid)).toBeGreaterThan(0);
  });

  test("enforces the 32 MiB threshold at the extraction boundary", async () => {
    expect(
      await extractPdfText(await fixture("pathological"), {
        ms: 5000,
        memoryMib: 32,
      }),
    ).toEqual({
      kind: "failed",
      reason: "PDF memory limit exceeded",
    });
  });
});
