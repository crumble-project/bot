import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runPdfExtraction } from "./pdf-extraction";
import { extractPdfText, samplePdfRss } from "./pdf-text";

const fixture = async (name: string) =>
  new Uint8Array(
    await Bun.file(
      new URL(`../../test/fixtures/${name}.pdf`, import.meta.url),
    ).arrayBuffer(),
  );

function oversizedTextPdf(pages: number): Uint8Array {
  const content = `BT /F1 0.01 Tf 72 720 Td ${`(${"x".repeat(1024)}) Tj `.repeat(64)} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 5} 0 R`).join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...Array.from(
      { length: pages },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>",
    ),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

async function workerErrorExit(bytes: Uint8Array): Promise<number> {
  let closed = () => {};
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const worker = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./pdf-worker.ts", import.meta.url)),
    ],
    {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      ipc() {},
      onDisconnect: closed,
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    worker.kill();
  }, 5000);
  try {
    await worker.stdin.write(bytes);
    await worker.stdin.end();
    const [code] = await Promise.all([worker.exited, disconnected]);
    expect(timedOut).toBe(false);
    return code;
  } finally {
    clearTimeout(timer);
    worker.kill();
  }
}

describe("extractPdfText", () => {
  test("accepts receipt delivered after worker exit", async () => {
    const events: string[] = [];
    const result = await runPdfExtraction(
      await fixture("text"),
      { ms: 5000, memoryMib: 512 },
      {
        workerCommand: [
          process.execPath,
          fileURLToPath(new URL("./pdf-worker.ts", import.meta.url)),
        ],
        sampleRss: samplePdfRss,
        spawnWorker(command, options) {
          const deliveries: Promise<void>[] = [];
          const worker = Bun.spawn(command, {
            ...options,
            ipc(message, child, handle) {
              deliveries.push(
                child.exited.then(() => {
                  events.push("receipt");
                  options.ipc?.(message, child, handle);
                }),
              );
            },
            async onDisconnect() {
              await worker.exited;
              await Promise.all(deliveries);
              events.push("disconnect");
              await options.onDisconnect?.();
            },
          });
          void worker.exited.then((code) => events.push(`exit:${code}`));
          return worker;
        },
      },
    );

    expect(events).toEqual(["exit:0", "receipt", "disconnect"]);
    expect(result.kind).toBe("text");
    if (result.kind === "text")
      expect(result.text).toContain("Crumble library fixture");
  });
  test("worker text limit fails without a timeout", async () => {
    const runtime = {
      workerCommand: [
        process.execPath,
        fileURLToPath(new URL("./pdf-worker.ts", import.meta.url)),
      ],
      sampleRss: async () => 1024 * 1024,
    };
    const limits = { ms: 5000, memoryMib: 512 };
    const onePage = await runPdfExtraction(
      oversizedTextPdf(1),
      limits,
      runtime,
    );
    expect(onePage.kind).toBe("text");
    if (onePage.kind === "text")
      expect(onePage.text.length).toBeGreaterThan(60000);
    expect(
      await runPdfExtraction(oversizedTextPdf(180), limits, runtime),
    ).toEqual({ kind: "failed", reason: "PDF extraction failed" });
    expect(await workerErrorExit(oversizedTextPdf(180))).not.toBe(0);
    const real = await extractPdfText(oversizedTextPdf(180), limits);
    expect(real.kind).toBe("failed");
    if (real.kind === "failed")
      expect([
        "PDF extraction failed",
        "PDF memory measurement unavailable",
      ]).toContain(real.reason);
  }, 15000);
  test("completion waits for an in-flight RSS sample", async () => {
    let release = () => {};
    let started = () => {};
    let observed = () => {};
    let pid = 0;
    let samples = 0;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sampling = new Promise<void>((resolve) => {
      started = resolve;
    });
    const frame = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const result = runPdfExtraction(
      await fixture("text"),
      { ms: 5000, memoryMib: 512 },
      {
        workerCommand: [
          process.execPath,
          fileURLToPath(new URL("./pdf-worker.ts", import.meta.url)),
        ],
        sampleRss: async (workerPid, signal) => {
          pid = workerPid;
          if (++samples === 2) {
            started();
            await Promise.race([
              held,
              new Promise<void>((resolve) =>
                signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              ),
            ]);
          }
          return samplePdfRss(workerPid, signal);
        },
        beforeInput: async (signal) => {
          await Promise.race([
            sampling,
            new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            ),
          ]);
        },
        onResultFrame: observed,
      },
    );
    try {
      await Promise.race([
        frame,
        result.then((failure) => {
          throw new Error(
            `Extraction ended before frame: ${JSON.stringify(failure)}`,
          );
        }),
      ]);
      expect(await samplePdfRss(pid)).toBeGreaterThan(0);
    } finally {
      release();
    }
    expect((await result).kind).toBe("text");
  }, 10000);
  for (const [scenario, reason] of [
    ["invalid-json", "PDF extraction failed"],
    ["invalid-schema", "Invalid PDF extraction output"],
    ["missing-delimiter", "Invalid PDF extraction output"],
    ["duplicate-result", "Invalid PDF extraction output"],
    ["trailing-output", "Invalid PDF extraction output"],
    ["excess-output", "PDF output limit exceeded"],
    ["exit-without-ack", "PDF extraction failed"],
    ["missing-receipt", "PDF extraction failed"],
    ["disconnect-before-result", "PDF extraction failed"],
    ["stalled-exit", "PDF extraction timed out"],
  ] as const) {
    test(`rejects ${scenario}`, async () => {
      const result = await runPdfExtraction(
        new Uint8Array(),
        { ms: 1000, memoryMib: 512 },
        {
          workerCommand: [
            process.execPath,
            fileURLToPath(
              new URL(
                "../../test/fixtures/pdf-protocol-worker.ts",
                import.meta.url,
              ),
            ),
            scenario,
          ],
          sampleRss: samplePdfRss,
        },
      );
      expect(result).toEqual({ kind: "failed", reason });
    });
  }

  for (const [value, reason] of [
    [null, "PDF memory measurement unavailable"],
    [513 * 1024 * 1024, "PDF memory limit exceeded"],
  ] as const) {
    test(`rejects an in-flight sample: ${reason}`, async () => {
      let started = () => {};
      let release = () => {};
      let observed = () => {};
      let count = 0;
      const sampling = new Promise<void>((resolve) => {
        started = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const frame = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const result = runPdfExtraction(
        await fixture("text"),
        { ms: 5000, memoryMib: 512 },
        {
          workerCommand: [
            process.execPath,
            fileURLToPath(new URL("./pdf-worker.ts", import.meta.url)),
          ],
          sampleRss: async (pid, signal) => {
            if (++count === 1) return samplePdfRss(pid, signal);
            started();
            await Promise.race([
              held,
              new Promise<void>((resolve) =>
                signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              ),
            ]);
            return value;
          },
          beforeInput: async (signal) => {
            await Promise.race([
              sampling,
              new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              ),
            ]);
          },
          onResultFrame: observed,
        },
      );
      try {
        await Promise.race([
          frame,
          result.then((failure) => {
            throw new Error(
              `Extraction ended before frame: ${JSON.stringify(failure)}`,
            );
          }),
        ]);
      } finally {
        release();
      }
      expect(await result).toEqual({ kind: "failed", reason });
    }, 10000);
  }

  test("parent termination releases a waiting real worker", async () => {
    const parent = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL("../../test/fixtures/pdf-parent.ts", import.meta.url),
        ),
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const reader = parent.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let workerPid = 0;
    try {
      while (!output.includes('"kind":"waiting"')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Parent exited before worker waited");
        output += decoder.decode(chunk.value, { stream: true });
      }
      for (const line of output.trim().split("\n")) {
        const event = JSON.parse(line) as { kind: string; pid: number };
        if (event.kind === "waiting") workerPid = event.pid;
      }
      expect(workerPid).toBeGreaterThan(0);
      parent.kill();
      await parent.exited;
      const deadline = performance.now() + 2000;
      while (
        (await samplePdfRss(workerPid)) !== null &&
        performance.now() < deadline
      )
        await Bun.sleep(10);
      expect(await samplePdfRss(workerPid)).toBeNull();
    } finally {
      parent.kill();
      if (workerPid && (await samplePdfRss(workerPid)) !== null)
        process.kill(workerPid);
      await reader.cancel();
    }
  });

  test("malformed input fails without a timeout", async () => {
    const bytes = new TextEncoder().encode("invalid");
    expect(await workerErrorExit(bytes)).not.toBe(0);
    const limits = { ms: 5000, memoryMib: 512 };
    expect(
      await runPdfExtraction(bytes, limits, {
        workerCommand: [
          process.execPath,
          fileURLToPath(new URL("./pdf-worker.ts", import.meta.url)),
        ],
        sampleRss: async () => 1024 * 1024,
      }),
    ).toEqual({ kind: "failed", reason: "PDF extraction failed" });
    const real = await extractPdfText(bytes, limits);
    expect(real.kind).toBe("failed");
    if (real.kind === "failed")
      expect([
        "PDF extraction failed",
        "PDF memory measurement unavailable",
      ]).toContain(real.reason);
  });

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
