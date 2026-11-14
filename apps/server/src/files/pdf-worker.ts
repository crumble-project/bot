import { getDocumentProxy } from "unpdf";
import { z } from "zod";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

try {
  const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  const pdf = await getDocumentProxy(bytes, { maxImageSize: 16_777_216 });
  const encoder = new TextEncoder();
  let output = "";
  let size = 0;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");

    size += encoder.encode(text).byteLength + 1;

    if (size > MAX_OUTPUT_BYTES)
      throw new Error("PDF text exceeds output limit");
    output += `${text}\n`;
    page.cleanup();
  }

  const ack = new Promise<void>((resolve, reject) => {
    process.once("message", (message) => {
      if (z.object({ kind: z.literal("ack") }).safeParse(message).success)
        resolve();
      else reject(new Error("Invalid acknowledgment"));
    });
    process.once("disconnect", () => reject(new Error("Parent disconnected")));
  });

  process.stdout.write(
    `${JSON.stringify(output.trim() ? { kind: "text", text: output.trim() } : { kind: "none" })}\n`,
  );
  await ack;

  if (!process.send || !process.connected)
    throw new Error("Parent disconnected");
  await new Promise<void>((resolve, reject) => {
    process.send?.({ kind: "ack-received" }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
  process.disconnect?.();
} catch {
  if (process.connected) process.disconnect?.();
  process.exitCode = 1;
}
