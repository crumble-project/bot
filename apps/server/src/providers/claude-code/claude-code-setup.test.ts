import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModels, type ClaudeCodeOptions } from "./setup";

// Spawned CLIs can pass the default 5 seconds on a loaded machine.
setDefaultTimeout(30_000);

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const PICKER_CLI = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "2.1.309 (Claude Code)"
  exit 0
fi
if [ "$1" = "auth" ]; then
  echo '{"loggedIn":true,"subscriptionType":"pro"}'
  exit 0
fi
cat > /dev/null
echo '{"type":"control_response","response":{"response":{"models":[{"value":"sonnet","resolvedModel":"claude-sonnet-5-5","description":"Sonnet · newer"},{"value":"future","resolvedModel":"claude-future-9","description":"Future model"},{"value":"best"}],"account":{"subscriptionType":"pro"}}}}'
`;

const options = (configDir: string, claude: string): ClaudeCodeOptions => ({
  command: claude,
  configDir,
  telemetry: false,
  env: {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
  },
});

describe("Claude Code picker", () => {
  test("turns the handshake's rows into routes, with Fable billed to credits off Max", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crumble-claude-setup-"));
    const claude = join(dir, "claude");

    dirs.push(dir);
    writeFileSync(claude, PICKER_CLI, { mode: 0o755 });

    const rows = await discoverModels(options(join(dir, "claude"), claude));

    expect(rows?.slice(0, 2)).toEqual([
      { id: "claude-sonnet-5-5[1m]", label: "Sonnet", note: "" },
      { id: "claude-future-9", label: "Future model", note: "unpinned" },
    ]);
    expect(rows?.find(({ label }) => label.startsWith("Fable"))?.note).toBe(
      "usage credits",
    );
    expect(rows?.some(({ id }) => id === "best")).toBe(false);
  });
});
