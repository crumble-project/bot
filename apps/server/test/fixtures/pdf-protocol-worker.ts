import { z } from "zod";

const scenario = process.argv[2];
const valid = '{"kind":"none"}\n';

let closing = false;

process.on("disconnect", () => {
  if (!closing) process.exit(1);
});

function disconnect() {
  closing = true;
  process.disconnect?.();
}

try {
  await Bun.stdin.arrayBuffer();

  process.on("message", (message) => {
    if (!z.object({ kind: z.literal("ack") }).safeParse(message).success)
      return;

    if (scenario === "stalled-exit") {
      process.send?.({ kind: "ack-received" });
    } else if (scenario === "missing-receipt") {
      setInterval(() => {}, 1000);
      disconnect();
    }
  });

  if (scenario === "disconnect-before-result") {
    setInterval(() => {}, 1000);
    disconnect();
  } else if (scenario === "excess-output") {
    process.stdout.write('{"kind":"text","text":"');
    const chunk = "x".repeat(64 * 1024);

    for (let i = 0; i <= 1024; i++) {
      if (!process.stdout.write(chunk)) {
        await new Promise<void>((resolve) =>
          process.stdout.once("drain", resolve),
        );
      }
    }
  } else {
    const output = new Map([
      ["invalid-json", "{\n"],
      ["invalid-schema", '{"kind":"invalid"}\n'],
      ["missing-delimiter", '{"kind":"none"}'],
      ["duplicate-result", valid + valid],
      ["trailing-output", valid + "x"],
      ["exit-without-ack", valid],
      ["missing-receipt", valid],
      ["stalled-exit", valid],
    ]);

    const frame = output.get(scenario ?? "");

    if (frame === undefined) throw new Error("Unknown protocol scenario");

    await new Promise<void>((resolve, reject) => {
      process.stdout.write(frame, (error) =>
        error ? reject(error) : resolve(),
      );
    });

    if (scenario === "missing-delimiter" || scenario === "exit-without-ack") {
      disconnect();
    }
  }
} catch {
  disconnect();
  process.exitCode = 1;
}
