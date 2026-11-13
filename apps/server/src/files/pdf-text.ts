import { fileURLToPath } from "node:url";
import { runPdfExtraction, type PdfResult } from "./pdf-extraction";

export async function samplePdfRss(
  pid: number,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    let rss: string | undefined;

    if (process.platform === "linux") {
      const status = await Bun.file(`/proc/${pid}/status`).text();

      rss = /^VmRSS:\s*(\d+)\s+kB\s*$/m.exec(status)?.[1];
    } else if (process.platform === "darwin") {
      if (signal?.aborted) return null;

      const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "ignore",
      });

      const stop = () => ps.kill();

      signal?.addEventListener("abort", stop, { once: true });

      try {
        const [output, code] = await Promise.all([
          new Response(ps.stdout).text(),
          ps.exited,
        ]);

        if (code === 0) rss = output.trim();
      } finally {
        signal?.removeEventListener("abort", stop);
        ps.kill();
      }
    }

    if (!rss || !/^\d+$/.test(rss)) return null;
    const kib = Number(rss);

    return Number.isSafeInteger(kib) && kib > 0 ? kib * 1024 : null;
  } catch {
    return null;
  }
}

export function extractPdfText(
  bytes: Uint8Array,
  limits: { ms: number; memoryMib: number },
): Promise<PdfResult> {
  return runPdfExtraction(bytes, limits, {
    workerCommand: [
      process.execPath,
      fileURLToPath(new URL("./pdf-worker.ts", import.meta.url)),
    ],
    sampleRss: samplePdfRss,
  });
}
