import { createProvider, type Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import type { CrumblePlugin, ExternalAuth } from "../../app/plugins";
import { CLAUDE_CODE_API, claudeCodeStreams } from "./adapter";
import {
  catalogLabel,
  contextWindow,
  pinnedRoutes,
  thinkingLevelMap,
} from "./catalog";
import {
  claudeCodeStatus,
  discoverModels,
  QUALIFIED_VERSIONS,
  resolveClaude,
  signInCommand,
  signOutCommand,
  type ClaudeCodeOptions,
  type ClaudeCodeStatus,
  type DiscoveredModel,
} from "./setup";

export const CLAUDE_CODE_PROVIDER = "claude-code";

const STATUS_TTL_MS = 30_000;
const OFF = ["0", "false", "no", "off"];

/** Where Claude Code runs from and keeps its login, from `CRUMBLE_CLAUDE_*` and the data directory. */
export function claudeCodeOptions(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): ClaudeCodeOptions & { workDir: string } {
  const options: ClaudeCodeOptions & { workDir: string } = {
    configDir: join(dataDir, "claude"),
    workDir: join(dataDir, "claude-work"),
    // Feature flags unlock models in Claude Code's picker; off keeps it quiet with fewer models.
    telemetry: !OFF.includes(
      (env["CRUMBLE_CLAUDE_TELEMETRY"] ?? "").trim().toLowerCase(),
    ),
    env,
  };

  const command = env["CRUMBLE_CLAUDE_COMMAND"];

  if (command) options.command = command;

  return options;
}

// Model ids drop the `[1m]` the adapter adds back for pinned routes; unpinned ids keep what the CLI announced.
const modelId = (route: string, pinned: boolean) =>
  pinned ? route.replace(/\[1m\]$/, "") : route;

function chatModel(id: string, name: string): Model<typeof CLAUDE_CODE_API> {
  return {
    id,
    name,
    api: CLAUDE_CODE_API,
    provider: CLAUDE_CODE_PROVIDER,
    baseUrl: "process://claude-code",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMap(id),
    input: ["text", "image"],
    contextWindow: contextWindow(id),
    maxTokens: 64_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

const pinnedModels = () =>
  pinnedRoutes().map(({ route, canonical }) =>
    chatModel(modelId(route, true), catalogLabel(canonical)),
  );

function discovered(rows: DiscoveredModel[]) {
  const pinned = new Set(pinnedRoutes().map((entry) => entry.route));

  return rows.map((row) =>
    chatModel(
      modelId(row.id, pinned.has(row.id)),
      row.note ? `${row.label} (${row.note})` : row.label,
    ),
  );
}

function externalAuth(
  status: ClaudeCodeStatus,
  options: ClaudeCodeOptions,
): ExternalAuth {
  const command = resolveClaude(options) ?? options.command ?? "claude";

  return {
    status: status.status,
    cliVersion: "cliVersion" in status ? (status.cliVersion ?? null) : null,
    qualifiedVersions: QUALIFIED_VERSIONS,
    signInCommand: signInCommand(command, options.configDir),
    signOutCommand: signOutCommand(command, options.configDir),
    message: "message" in status ? status.message : null,
  };
}

/**
 * Bots run on the owner's Claude subscription through the official Claude Code CLI on the server
 * ([feature 0006](https://github.com/crumble-project/spec/blob/main/features/0006-claude-code-provider.md)). Sign-in
 * stays in Claude Code; Crumble only reads its status.
 */
export function claudeCodePlugin(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): CrumblePlugin {
  const options = claudeCodeOptions(dataDir, env);
  mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
  chmodSync(options.configDir, 0o700);
  let cached: { at: number; status: Promise<ClaudeCodeStatus> } | undefined;

  const status = () => {
    if (!cached || Date.now() - cached.at > STATUS_TTL_MS)
      cached = { at: Date.now(), status: claudeCodeStatus(options) };

    return cached.status;
  };

  const invalidateStatus = () => {
    cached = undefined;
  };

  const provider = createProvider<typeof CLAUDE_CODE_API>({
    id: CLAUDE_CODE_PROVIDER,
    name: "Claude Code",
    auth: {
      apiKey: {
        name: "Claude Code sign-in",
        // Usable only when the CLI is installed, qualified, and signed in; a turn otherwise fails with the reason.
        check: async () =>
          (await status()).status === "signed_in"
            ? { type: "api_key", source: "Claude Code" }
            : undefined,
        resolve: async () => ({
          auth: { apiKey: CLAUDE_CODE_PROVIDER },
          source: "Claude Code",
        }),
      },
    },
    models: pinnedModels(),
    fetchModels: async () => {
      const rows = await discoverModels(options);

      return rows ? discovered(rows) : pinnedModels();
    },
    api: claudeCodeStreams({ ...options, status, invalidateStatus }),
  });

  return {
    id: "claude-code",
    providers: [
      {
        provider,
        externalAuth: async () => externalAuth(await status(), options),
      },
    ],
  };
}
