// Ported from Hermes' claude-subscription-directsdk directsdk_setup.py (MIT, see THIRD_PARTY_NOTICES.md).
import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { z } from "zod";
import { catalogLabel, nativeModel, pinnedRoutes } from "./catalog";
import { Admission } from "./relay";

/** Claude Code versions whose replay, tool denial, recovery, and relay behavior passed the wire tests. */
export const QUALIFIED_VERSIONS = ["2.1.309"];

export type ClaudeCodeOptions = {
  /** An explicit executable; otherwise `claude` on PATH or in the usual install directories. */
  command?: string | undefined;
  /** Claude Code's own config directory, holding its login. */
  configDir: string;
  /** Let Claude Code send telemetry and fetch the feature flags that unlock models in its picker. */
  telemetry: boolean;
  /** The environment Crumble runs in; the child gets an allowlisted part of it. */
  env: NodeJS.ProcessEnv;
};

export type ClaudeCodeStatus =
  | { status: "cli_missing"; message: string }
  | { status: "unsupported_version"; cliVersion: string; message: string }
  | { status: "signed_out"; cliVersion: string; message: string }
  | { status: "error"; cliVersion?: string; message: string }
  | { status: "signed_in"; cliVersion: string; plan: string };

// Probed after PATH: a service launch inherits a bare PATH that carries none of them.
const HOME_PREFIXES = [
  ".local/bin",
  ".claude/local",
  "bin",
  ".npm-global/bin",
  ".bun/bin",
  ".volta/bin",
];

const SYSTEM_PREFIXES = ["/opt/homebrew/bin", "/usr/local/bin"];

// Never wanted from a child Crumble starts: a background self-update, the feedback upload path, and the CLI's own
// session-title request, which would race the turn for the one request the relay admits.
const ALWAYS_QUIET = {
  DISABLE_AUTOUPDATER: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
};

// Any one of these turns off the feature-flag fetch, and with it every model the picker only offers through a flag.
const QUIET_TRAFFIC = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
};

// The child sees only these from Crumble's environment, so provider keys, base URLs, cloud backends and Crumble's
// own secrets never reach it. Proxy, certificate, and the owner's own opt-outs pass through.
const INHERITED = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "DISABLE_TELEMETRY",
  "DO_NOT_TRACK",
  "DISABLE_ERROR_REPORTING",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];

export const installHint = (options: ClaudeCodeOptions) =>
  options.command
    ? `Claude Code was not found at CRUMBLE_CLAUDE_COMMAND (${options.command}).`
    : "Claude Code is not installed: no `claude` on PATH or in the usual install directories. Install it (https://code.claude.com/docs/en/setup) or set CRUMBLE_CLAUDE_COMMAND to the executable.";

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
};

const which = (name: string, directories: string[]) =>
  directories
    .flatMap((directory) => (directory ? [join(directory, name)] : []))
    .find(executable);

/** The Claude Code executable, or undefined when none is installed. */
export function resolveClaude(options: ClaudeCodeOptions) {
  const head = options.command ?? "claude";

  if (isAbsolute(head)) return executable(head) ? head : undefined;
  const found = which(head, (options.env["PATH"] ?? "").split(delimiter));

  // Only the default bare name: an explicit command is the owner's choice, never second-guessed.
  if (found || head !== "claude") return found;
  const home = options.env["HOME"];

  return which(head, [
    ...(home ? HOME_PREFIXES.map((prefix) => join(home, prefix)) : []),
    ...SYSTEM_PREFIXES,
  ]);
}

/**
 * The environment of every process Crumble starts: allowlisted inherited values, the login identity Claude Code's
 * local login check reads, the selected config directory, and the traffic policy.
 */
export function childEnv(options: ClaudeCodeOptions) {
  const env: Record<string, string> = {};

  for (const name of INHERITED) {
    const value = options.env[name];

    if (value !== undefined) env[name] = value;
  }

  // Without USER a logged-in CLI reports `loggedIn: false`, instantly and without a request.
  const user = env["USER"] ?? userInfo().username;

  env["USER"] ??= user;
  env["LOGNAME"] ??= user;
  env["CLAUDE_CONFIG_DIR"] = options.configDir;
  Object.assign(env, ALWAYS_QUIET, options.telemetry ? {} : QUIET_TRAFFIC);

  return env;
}

type Run = { code: number | null; stdout: string; stderr: string };

/** Runs a short Claude Code command to completion with a deadline. */
export function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  input = "",
  cwd?: string,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const authStatus = z.looseObject({
  loggedIn: z.boolean().optional(),
  subscriptionType: z.string().nullish(),
});

const jsonLine = (line: string) => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** `pro` (auth status) and `Claude Pro` (handshake) name the same plan. */
const planLabel = (raw: string | null | undefined) => {
  const value = (raw ?? "").trim();

  if (!value) return "";

  return value.toLowerCase().startsWith("claude")
    ? value
    : `Claude ${value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}`;
};

export const signInCommand = (command: string, configDir: string) =>
  `CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)} ${command} auth login`;

export const signOutCommand = (command: string, configDir: string) =>
  `CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)} ${command} auth logout`;

/** Asks the CLI itself, never Anthropic, whether it is installed, qualified, and signed in. */
export async function claudeCodeStatus(
  options: ClaudeCodeOptions,
): Promise<ClaudeCodeStatus> {
  const command = resolveClaude(options);

  if (!command) return { status: "cli_missing", message: installHint(options) };
  const env = childEnv(options);
  let version: string;

  try {
    const result = await run(command, ["--version"], env, 20_000);

    version = /^\s*(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? "";
  } catch {
    version = "";
  }

  if (!version)
    return {
      status: "error",
      message: `${command} --version did not report a version.`,
    };

  if (!QUALIFIED_VERSIONS.includes(version))
    return {
      status: "unsupported_version",
      cliVersion: version,
      message: `Claude Code ${version} is not qualified for Crumble. Install one of: ${QUALIFIED_VERSIONS.join(", ")}.`,
    };

  try {
    const result = await run(
      command,
      ["auth", "status", "--json"],
      env,
      20_000,
    );

    const parsed = authStatus.safeParse(jsonLine(result.stdout.trim()));

    if (parsed.success && parsed.data.loggedIn === true)
      return {
        status: "signed_in",
        cliVersion: version,
        plan: planLabel(parsed.data.subscriptionType),
      };
  } catch {
    return {
      status: "error",
      cliVersion: version,
      message: "Claude Code did not report its login state.",
    };
  }

  return {
    status: "signed_out",
    cliVersion: version,
    message: "Claude Code is not signed in for Crumble.",
  };
}

export type DiscoveredModel = {
  id: string;
  label: string;
  /** `unpinned` for a model the catalog does not know yet; `usage credits` when it bills to credits. */
  note: string;
};

const pickerRow = z.looseObject({
  value: z.string().nullish(),
  resolvedModel: z.string().nullish(),
  description: z.string().nullish(),
});

const handshake = z.object({
  type: z.literal("control_response"),
  response: z.looseObject({
    response: z
      .looseObject({
        models: z.array(pickerRow).nullish(),
        account: z
          .looseObject({ subscriptionType: z.string().nullish() })
          .nullish(),
      })
      .optional(),
  }),
});

export async function discoverModels(
  options: ClaudeCodeOptions,
): Promise<DiscoveredModel[] | undefined> {
  const command = await signedInCommand(options);

  if (!command) return undefined;
  const picker = await readPicker(command, options);

  return picker && pickerModels(picker.rows, picker.plan);
}

async function signedInCommand(options: ClaudeCodeOptions) {
  const status = await claudeCodeStatus(options);
  const command = resolveClaude(options);

  // Logged out, the handshake still answers with a generic default list.
  return status.status === "signed_in" ? command : undefined;
}

type PickerContent = { rows: z.infer<typeof pickerRow>[]; plan: string };

async function readPicker(command: string, options: ClaudeCodeOptions) {
  const env = childEnv(options);
  const gate = new Admission("https://api.anthropic.com", 40_000);
  const cwd = mkdtempSync(join(tmpdir(), "crumble-claude-picker-"));
  let content: PickerContent = { rows: [], plan: "" };

  try {
    env["ANTHROPIC_BASE_URL"] = gate.url;
    content = pickerContent(await pickerHandshake(command, env, cwd));
  } catch {
    return undefined;
  } finally {
    await gate.close();
    rmSync(cwd, { recursive: true, force: true });
  }

  return gate.used || content.rows.length === 0 ? undefined : content;
}

function pickerContent(
  response: Awaited<ReturnType<typeof pickerHandshake>>,
): PickerContent {
  return {
    rows: response?.models ?? [],
    plan: (response?.account?.subscriptionType ?? "").toLowerCase(),
  };
}

async function pickerHandshake(
  command: string,
  env: Record<string, string>,
  cwd: string,
) {
  const result = await run(
    command,
    [
      "-p",
      "--model",
      "sonnet",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--no-session-persistence",
    ],
    env,
    40_000,
    `${JSON.stringify({ type: "control_request", request_id: "crumble-picker", request: { subtype: "initialize" } })}\n`,
    cwd,
  );

  return result.stdout
    .split("\n")
    .map((line) => handshake.safeParse(jsonLine(line)))
    .find((parsed) => parsed.success)?.data?.response.response;
}

type PickerRoute = { route: string; known: boolean; base: string };

function unpinnedRoute(
  row: z.infer<typeof pickerRow>,
  base: string,
  route: string,
  longContext: Set<string>,
): PickerRoute | undefined {
  // A value the CLI did not resolve (`default`, `best`) is an alias row, not a model.
  if (!row.resolvedModel) return undefined;

  return {
    route: longContext.has(base) ? `${base}[1m]` : route,
    known: false,
    base,
  };
}

function pickerRoute(
  row: z.infer<typeof pickerRow>,
  announced: string,
  pinned: Set<string>,
  longContext: Set<string>,
): PickerRoute | undefined {
  const base = announced.replace(/\[1m\]$/, "");

  if (!base) return undefined;
  const route = nativeModel(base);

  return pinned.has(route)
    ? { route, known: true, base }
    : unpinnedRoute(row, base, route, longContext);
}

const pickerLabel = (description: string | null | undefined, route: string) =>
  (description ?? "").split("·")[0]?.trim() || route;

const billedToCredits = (
  description: string | null | undefined,
  base: string,
  creditBilled: Set<string>,
) =>
  (description ?? "").toLowerCase().includes("usage credit") ||
  creditBilled.has(base);

const creditNote = (known: boolean) =>
  known ? "usage credits" : "usage credits · unpinned";

function mergePickerRow(
  row: z.infer<typeof pickerRow>,
  resolved: PickerRoute,
  routes: Map<string, DiscoveredModel>,
  creditBilled: Set<string>,
) {
  const { route, known, base } = resolved;

  const entry = routes.get(route) ?? {
    id: route,
    label: pickerLabel(row.description, route),
    note: known ? "" : "unpinned",
  };

  if (billedToCredits(row.description, base, creditBilled))
    entry.note = creditNote(known);
  routes.set(route, entry);
}

function mergePickerRows(
  rows: z.infer<typeof pickerRow>[],
  announced: string[],
  creditBilled: Set<string>,
) {
  const pinned = new Set(pinnedRoutes().map((entry) => entry.route));

  const longContext = new Set(
    announced.flatMap((model) =>
      model.endsWith("[1m]") ? [model.replace(/\[1m\]$/, "")] : [],
    ),
  );

  const routes = new Map<string, DiscoveredModel>();

  for (const [index, row] of rows.entries()) {
    const resolved = pickerRoute(
      row,
      announced[index] ?? "",
      pinned,
      longContext,
    );

    if (resolved) mergePickerRow(row, resolved, routes, creditBilled);
  }

  return routes;
}

function addPinnedRoutes(
  routes: Map<string, DiscoveredModel>,
  creditBilled: Set<string>,
) {
  for (const { route, canonical } of pinnedRoutes())
    if (!routes.has(route))
      routes.set(route, {
        id: route,
        label: catalogLabel(canonical),
        note: creditBilled.has(canonical) ? "usage credits" : "",
      });
}

function pickerModels(rows: z.infer<typeof pickerRow>[], plan: string) {
  // Pro and Team standard seats bill Fable to usage credits from the first request.
  const creditBilled = new Set(
    plan && !plan.includes("max") ? ["claude-fable-5-1"] : [],
  );

  const announced = rows.map((row) => row.resolvedModel ?? row.value ?? "");
  const routes = mergePickerRows(rows, announced, creditBilled);

  if (routes.size === 0) return undefined;
  addPinnedRoutes(routes, creditBilled);

  return [...routes.values()];
}
