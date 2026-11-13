import { z } from "zod";

const resultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("none") }),
]);

export type PdfResult =
  | { kind: "text"; text: string }
  | { kind: "none" }
  | { kind: "failed"; reason: string };

export type PdfLimits = { ms: number; memoryMib: number };

export type PdfRuntime = {
  workerCommand: readonly string[];
  spawnWorker?: (
    command: string[],
    options: Bun.Spawn.SpawnOptions<"pipe", "pipe", "ignore">,
  ) => Bun.Subprocess<"pipe", "pipe", "ignore">;
  sampleRss: (pid: number, signal?: AbortSignal) => Promise<number | null>;
  beforeInput?: (signal: AbortSignal) => Promise<void>;
  onResultFrame?: () => void;
};

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const receiptSchema = z.object({ kind: z.literal("ack-received") });

function validLimits(limits: PdfLimits): boolean {
  return (
    Number.isFinite(limits.ms) &&
    limits.ms > 0 &&
    Number.isFinite(limits.memoryMib) &&
    limits.memoryMib > 0
  );
}

function appendPdfFrame(
  chunks: Uint8Array[],
  value: Uint8Array,
): PdfResult | undefined {
  const delimiter = value.indexOf(10);

  if (delimiter === -1) {
    chunks.push(value);

    return;
  }

  if (delimiter !== value.length - 1)
    return { kind: "failed", reason: "Invalid PDF extraction output" };

  chunks.push(value.subarray(0, delimiter));

  try {
    const json: unknown = JSON.parse(
      new TextDecoder().decode(Buffer.concat(chunks)),
    );

    const parsed = resultSchema.safeParse(json);

    return parsed.success
      ? parsed.data
      : { kind: "failed", reason: "Invalid PDF extraction output" };
  } catch {
    return { kind: "failed", reason: "PDF extraction failed" };
  }
}

export async function runPdfExtraction(
  bytes: Uint8Array,
  limits: PdfLimits,
  runtime: PdfRuntime,
): Promise<PdfResult> {
  if (!validLimits(limits))
    return { kind: "failed", reason: "Invalid extraction limits" };

  let reason: string | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let frame: z.infer<typeof resultSchema> | undefined;
  let received = false;
  let acknowledged = false;
  let closed = false;
  let measured = false;
  const monitor = new AbortController();
  let resolveFrame = () => {};

  const frameReady = new Promise<void>((resolve) => {
    resolveFrame = resolve;
  });

  let resolveClosed = () => {};

  const ipcClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  let resolveSample = () => {};

  const firstSample = new Promise<void>((resolve) => {
    resolveSample = resolve;
  });

  const fail = (message: string) => {
    reason ??= message;
    monitor.abort();
    resolveFrame();
    resolveSample();

    try {
      child?.disconnect();
    } catch {}

    child?.kill();
  };

  const timer = setTimeout(() => fail("PDF extraction timed out"), limits.ms);

  try {
    const running = (runtime.spawnWorker ?? Bun.spawn)(
      [...runtime.workerCommand],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        ipc(message) {
          if (
            acknowledged &&
            receiptSchema.safeParse(message).success &&
            !received
          )
            received = true;
          else fail("Invalid PDF extraction output");
        },
        onDisconnect() {
          closed = true;
          resolveClosed();

          if (!received) {
            if (frame) fail("PDF extraction failed");
            else {
              monitor.abort();
              resolveFrame();
              resolveSample();
              child?.kill();
            }
          }
        },
      },
    );

    child = running;

    const watch = (async () => {
      while (!frame && !reason && !closed) {
        const rss = await runtime.sampleRss(running.pid, monitor.signal);
        resolveSample();

        if (reason || closed) break;

        if (rss === null) {
          fail("PDF memory measurement unavailable");
          break;
        }

        measured = true;

        if (rss > limits.memoryMib * 1024 * 1024) {
          fail("PDF memory limit exceeded");
          break;
        }

        if (!frame) await Bun.sleep(25);
      }
    })().catch(() => {
      resolveSample();

      if (!closed) fail("PDF memory measurement unavailable");
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

        if (frame) {
          fail("Invalid PDF extraction output");
          break;
        }

        const parsed = appendPdfFrame(chunks, value);

        if (!parsed) continue;

        if (parsed.kind === "failed") {
          fail(parsed.reason);
          break;
        }

        frame = parsed;
        runtime.onResultFrame?.();
        resolveFrame();
      }

      if (!frame && !reason)
        fail(
          size > 0 ? "Invalid PDF extraction output" : "PDF extraction failed",
        );
    })().catch(() => fail("PDF extraction failed"));

    const writeInput = async () => {
      if (reason || closed) return;

      if (runtime.beforeInput) await runtime.beforeInput(monitor.signal);

      if (reason || closed) return;

      await running.stdin.write(bytes);
      await running.stdin.end();
    };

    await firstSample;
    await writeInput();

    await frameReady;
    await watch;

    if (closed && !received) {
      await read;
      fail("PDF extraction failed");
    }

    const acknowledge = () => {
      if (!reason && frame && measured) {
        if (closed) fail("PDF extraction failed");
        else {
          acknowledged = true;

          try {
            running.send({ kind: "ack" });
          } catch {
            fail("PDF extraction failed");
          }
        }
      }
    };

    acknowledge();

    const [code] = await Promise.all([running.exited, read, ipcClosed]);

    if (reason) return { kind: "failed", reason };

    if (!received || code !== 0 || !frame)
      return { kind: "failed", reason: "PDF extraction failed" };

    return frame;
  } catch {
    return { kind: "failed", reason: reason ?? "PDF extraction failed" };
  } finally {
    clearTimeout(timer);
    monitor.abort();

    try {
      child?.disconnect();
    } catch {}

    child?.kill();
  }
}
