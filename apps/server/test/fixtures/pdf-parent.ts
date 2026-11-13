import { fileURLToPath } from "node:url";
import { runPdfExtraction } from "../../src/files/pdf-extraction";
import { samplePdfRss } from "../../src/files/pdf-text";

const worker = fileURLToPath(
  new URL("../../src/files/pdf-worker.ts", import.meta.url),
);

const pdf = await Bun.file(new URL("./text.pdf", import.meta.url)).bytes();
let pid = 0;
let samples = 0;
let sampleStarted = () => {};

const started = new Promise<void>((resolve) => {
  sampleStarted = resolve;
});

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("Aborted"));

      return;
    }

    signal.addEventListener("abort", () => reject(new Error("Aborted")), {
      once: true,
    });
  });
}

const result = await runPdfExtraction(
  pdf,
  { ms: 5000, memoryMib: 512 },
  {
    workerCommand: [process.execPath, worker],
    sampleRss: async (workerPid, signal) => {
      pid = workerPid;
      samples++;

      if (samples === 1) {
        process.stdout.write(`${JSON.stringify({ kind: "worker", pid })}\n`);

        return samplePdfRss(pid, signal);
      }

      sampleStarted();

      if (!signal) throw new Error("Sampler requires an abort signal");

      return waitForAbort(signal);
    },
    beforeInput: async (signal) => {
      await Promise.race([started, waitForAbort(signal)]);
    },
    onResultFrame: () => {
      process.stdout.write(`${JSON.stringify({ kind: "waiting", pid })}\n`);
    },
  },
);

process.stdout.write(`${JSON.stringify({ kind: "result", result })}\n`);
