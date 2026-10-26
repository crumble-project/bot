import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogLabel, pinnedRoutes } from "./catalog";
import { discoverModels, type ClaudeCodeOptions } from "./setup";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

// Answers the version, login and picker handshake like Claude Code's stream-json mode, over no network.
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

    expect(rows).toContainEqual({
      id: "claude-sonnet-5-5[1m]",
      label: "Sonnet",
      note: "",
    });
    expect(rows).toContainEqual({
      id: "claude-future-9",
      label: "Future model",
      note: "unpinned",
    });
    expect(rows).toContainEqual({
      id: "claude-fable-5-1[1m]",
      label: catalogLabel("claude-fable-5-1"),
      note: "usage credits",
    });
    // The unresolved alias row adds nothing; the two resolved rows join the pinned catalog.
    expect(rows).toHaveLength(pinnedRoutes().length + 1);
  });
});
