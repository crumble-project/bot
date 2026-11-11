import { getDocumentProxy } from "unpdf";

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

  process.stdout.write(
    JSON.stringify(
      output.trim() ? { kind: "text", text: output.trim() } : { kind: "none" },
    ),
  );
} catch {
  process.exitCode = 1;
}
