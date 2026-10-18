import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server";

test.serial(
  "server owns its data directory exclusively and releases it after graceful shutdown",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-"));
    const port = 18000 + Math.floor(Math.random() * 1000);

    try {
      const running = await startServer({ dataDir, port });
      expect((await fetch(new URL("/health", running.server.url))).status).toBe(
        200,
      );
      await expect(startServer({ dataDir, port })).rejects.toThrow(
        "already being held",
      );
      await running.close();
      const reopened = await startServer({ dataDir, port });
      await reopened.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test.serial("loads the workspace skills directory by default", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-skills-"));
  const port = 19000 + Math.floor(Math.random() * 1000);

  try {
    const token = "s".repeat(40);
    const running = await startServer({ dataDir, port, token });

    const response = await fetch(new URL("/v1/skills", running.server.url), {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "common:tasks/SKILL.md",
          source: "bundled",
          name: "tasks",
        }),
        expect.objectContaining({
          id: "common:bot-messaging/SKILL.md",
          source: "bundled",
          name: "bot-messaging",
        }),
      ]),
    );
    await running.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test.serial(
  "failed listener startup releases the push worker and data lock",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-push-startup-"));
    let unexpected: Awaited<ReturnType<typeof startServer>> | undefined;

    try {
      let failure: unknown;

      try {
        unexpected = await startServer({ dataDir, port: 65536 });
      } catch (error) {
        failure = error;
      }

      await unexpected?.close();
      expect(failure).toBeDefined();
      const running = await startServer({ dataDir, port: 0 });
      await running.close();
    } finally {
      await unexpected?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
