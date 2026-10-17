import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server";

test("server owns its data directory exclusively and releases it after graceful shutdown", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-"));
  try {
    const running = await startServer({ dataDir, port: 0 });
    expect((await fetch(new URL("/health", running.server.url))).status).toBe(
      200,
    );
    await expect(startServer({ dataDir, port: 0 })).rejects.toThrow(
      "already being held",
    );
    await running.close();
    const reopened = await startServer({ dataDir, port: 0 });
    await reopened.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
