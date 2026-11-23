import { fileURLToPath } from "node:url";

const [database, ...args] = process.argv.slice(2);
if (database !== "store" && database !== "push") {
  process.stderr.write(
    "Usage: bun tools/generate-migrations.ts <store|push> [drizzle-kit options]\n",
  );
  process.exit(1);
}
const result = Bun.spawnSync(
  [
    "bunx",
    "--no-install",
    "drizzle-kit",
    "generate",
    "--config",
    `drizzle.${database}.config.ts`,
    ...args,
  ],
  {
    cwd: fileURLToPath(new URL("../apps/server/", import.meta.url)),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (result.exitCode !== 0) {
  process.exit(result.exitCode);
}
await import("./normalize-migrations");
