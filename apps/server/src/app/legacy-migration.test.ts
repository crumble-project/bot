/* oxlint-disable anti-slop/require-readable-spacing */

import { describe, expect, test } from "bun:test";
import { afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import lockfile from "proper-lockfile";
import { Database } from "bun:sqlite";
import { migrateLegacyData } from "./legacy-migration";
import { Store } from "../shared/store";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "crumble-legacy-"));
  dirs.push(dataDir);
  const store = new Store(dataDir);
  const agent = store.createAgent({
    name: "Legacy bot",
    avatar: "sparkles",
    description: "",
    instructions: "hello",
    provider: "openai",
    model: "gpt-4.1",
    enabled: true,
    tools: ["memory"],
    skills: [],
    mcpServers: [],
    delegates: [],
  });
  store.setCredential("openai", "encrypted-secret");
  store.close();
  const auth = new Database(join(dataDir, "auth.sqlite"));
  auth.run('CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL)');
  auth
    .query('INSERT INTO "user" (id, email) VALUES (?, ?)')
    .run("user-1", "owner@example.com");
  auth.close();
  writeFileSync(join(dataDir, "push.sqlite"), "push");
  return { dataDir, agentId: agent.id };
}

describe("legacy owner migration", () => {
  test("copies the encrypted store and preserves the legacy root", async () => {
    const { dataDir, agentId } = fixture();
    const key = readFileSync(join(dataDir, ".secret.key"));
    const result = await migrateLegacyData({
      dataDir,
      email: "OWNER@example.com",
    });
    expect(result.userId).toBe("user-1");
    expect(readFileSync(join(result.target, ".secret.key"))).toEqual(key);
    const migrated = new Store(result.target);
    expect(migrated.getAgent(agentId)?.name).toBe("Legacy bot");
    expect(migrated.getCredential("openai")).toBe("encrypted-secret");
    migrated.close();
    expect(readFileSync(join(dataDir, "store.sqlite"))).toEqual(
      readFileSync(join(result.target, "store.sqlite")),
    );
  });

  test("refuses an initialized or populated target", async () => {
    const { dataDir } = fixture();
    mkdirSync(join(dataDir, "users", "user-1"), { recursive: true });
    writeFileSync(join(dataDir, "users", "user-1", "store.sqlite"), "existing");
    await expect(
      migrateLegacyData({ dataDir, email: "owner@example.com" }),
    ).rejects.toThrow("already exists and is not empty");
  });

  test("refuses while the server lock is held", async () => {
    const { dataDir } = fixture();
    const release = await lockfile.lock(dataDir, {
      stale: 30000,
      update: 10000,
      retries: 0,
    });
    try {
      await expect(
        migrateLegacyData({ dataDir, email: "owner@example.com" }),
      ).rejects.toThrow();
    } finally {
      await release();
    }
  });

  test("requires an existing Better Auth user and prevents repeat migration", async () => {
    const { dataDir } = fixture();
    await expect(
      migrateLegacyData({ dataDir, email: "missing@example.com" }),
    ).rejects.toThrow("no Better Auth user exists");
    await migrateLegacyData({ dataDir, email: "owner@example.com" });
    await expect(
      migrateLegacyData({ dataDir, email: "owner@example.com" }),
    ).rejects.toThrow("already been migrated");
  });
});
