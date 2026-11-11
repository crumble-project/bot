import { fileURLToPath } from "node:url";
import { z } from "zod";

const resultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("none") }),
]);

type Result =
  | { kind: "text"; text: string }
  | { kind: "none" }
  | { kind: "failed"; reason: string };

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

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

export async function extractPdfText(
  bytes: Uint8Array,
  limits: { ms: number; memoryMib: number },
): Promise<Result> {
  if (
    !Number.isFinite(limits.ms) ||
    limits.ms <= 0 ||
    !Number.isFinite(limits.memoryMib) ||
    limits.memoryMib <= 0
  ) {
    return { kind: "failed", reason: "Invalid extraction limits" };
  }

  let reason: string | undefined;
  let measured = false;
  const monitor = new AbortController();
  let child: ReturnType<typeof Bun.spawn> | undefined;

  const fail = (message: string) => {
    reason ??= message;
    child?.kill();
    monitor.abort();
  };

  const timer = setTimeout(() => fail("PDF extraction timed out"), limits.ms);

  try {
    const running = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./pdf-worker.ts", import.meta.url)),
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      },
    );

    child = running;

    let firstSample: () => void = () => {};

    const ready = new Promise<void>((resolve) => {
      firstSample = resolve;
    });

    const watch = (async () => {
      while (running.exitCode === null && !reason) {
        const rss = await samplePdfRss(running.pid, monitor.signal);

        firstSample();

        if (rss === null) {
          if (running.exitCode === null || !measured)
            fail("PDF memory measurement unavailable");
          break;
        }

        measured = true;

        if (rss > limits.memoryMib * 1024 * 1024) {
          fail("PDF memory limit exceeded");
          break;
        }

        await Bun.sleep(25);
      }
    })().catch(() => {
      firstSample();
      fail("PDF memory measurement unavailable");
    });

    const read = (async () => {
      const reader = running.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;

      while (true) {
        const { value, done } = await reader.read();

        if (done) break;
        size += value.byteLength;

        if (size > MAX_STDOUT_BYTES) {
          fail("PDF output limit exceeded");
          break;
        }

        chunks.push(value);
      }

      return new TextDecoder().decode(Buffer.concat(chunks));
    })();

    await ready;

    if (!reason) {
      await running.stdin.write(bytes);
      await running.stdin.end();
    }

    const [output, code] = await Promise.all([read, running.exited, watch]);

    if (reason) return { kind: "failed", reason };

    if (!measured)
      return { kind: "failed", reason: "PDF memory measurement unavailable" };

    if (code !== 0) return { kind: "failed", reason: "PDF extraction failed" };
    const result = resultSchema.safeParse(JSON.parse(output));

    return result.success
      ? result.data
      : { kind: "failed", reason: "Invalid PDF extraction output" };
  } catch {
    return { kind: "failed", reason: reason ?? "PDF extraction failed" };
  } finally {
    clearTimeout(timer);
    child?.kill();
    monitor.abort();
  }
}
