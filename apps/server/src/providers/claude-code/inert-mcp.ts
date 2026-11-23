import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { Match } from "effect";

const manifestPath = process.argv[2];

if (!manifestPath) {
  throw new Error("Usage: inert-mcp.ts <tools.json>");
}

const tools = z
  .array(z.json())
  .parse(JSON.parse(readFileSync(manifestPath, "utf8")));

const request = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
});

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) {
    continue;
  }
  const row = request.parse(JSON.parse(line));

  const result = Match.value(row.method).pipe(
    Match.when("initialize", () => ({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "crumble-inert-inventory", version: "1" },
    })),
    Match.when("tools/list", () => ({ tools })),
    Match.when("tools/call", () => ({
      isError: true,
      content: [
        {
          type: "text",
          text: "Denied: tools here are inert; only Crumble runs tools.",
        },
      ],
    })),
    Match.orElse(() => ({})),
  );

  if (row.id !== undefined) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: row.id, result })}\n`,
    );
  }
}
