import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createAPI } from "../../app/api";
import {
  acceptsThinkingDisable,
  contextWindow,
  nativeModel,
  supportsAdaptiveThinking,
} from "./catalog";
import { claudeCodePlugin, claudeCodeOptions } from "./plugin";
import { childEnv, claudeCodeStatus } from "./setup";
import { pluginProviders } from "../../plugins/plugins";
import { standaloneSignIns } from "../provider-auth";
import type { AgentRuntime } from "../../bots/runtime";
import { standaloneScheduler } from "../../schedules/scheduler";
import { standaloneBots } from "../../bots/bots";
import { Store } from "../../../test/support/store";

const FAKE = join(import.meta.dir, "../../../test/fixtures/fake-claude.ts");

let dirs: string[] = [];

beforeAll(() => chmodSync(FAKE, 0o755));

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A data directory whose Claude Code is the fake, configured through a settings file in its config directory. */
function dataDir(fake: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crumble-claude-plugin-"));

  dirs.push(dir);
  mkdirSync(join(dir, "claude"));
  writeFileSync(join(dir, "claude", "fake.json"), JSON.stringify(fake));

  return dir;
}

const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env["PATH"] ?? "",
  CRUMBLE_CLAUDE_COMMAND: FAKE,
  ...extra,
});

describe("Claude Code catalog", () => {
  // From Hermes' test_directsdk_models.py: every spelling lands on the pinned native route.
  test.each([
    ["sonnet", "claude-sonnet-5-5[1m]"],
    ["sonnet-5-5", "claude-sonnet-5-5[1m]"],
    ["sonnet-5.5", "claude-sonnet-5-5[1m]"],
    ["opus", "claude-opus-5-5[1m]"],
    ["opus-5-5", "claude-opus-5-5[1m]"],
    ["haiku", "claude-haiku-5-5[1m]"],
    ["haiku-5.5", "claude-haiku-5-5[1m]"],
    ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
    ["haiku-4-5", "claude-haiku-4-5-20251001"],
    ["haiku-4.5", "claude-haiku-4-5-20251001"],
    ["opus-4.8", "claude-opus-4-8[1m]"],
    ["fable", "claude-fable-5-1[1m]"],
    ["claude-sonnet-5", "claude-sonnet-5[1m]"],
    ["unqualified-future-model", "unqualified-future-model"],
  ])("%s runs as %s", (requested, expected) => {
    expect(nativeModel(requested)).toBe(expected);
  });

  test("an unknown model is promised the 200K window native gives it, never a guessed larger one", () => {
    expect(contextWindow("claude-sonnet-5-5")).toBe(1_000_000);
    expect(contextWindow("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(contextWindow("unqualified-future-model")).toBe(200_000);
  });

  test("thinking cannot be turned off on the families that reject the disable", () => {
    for (const route of [
      "sonnet",
      "sonnet-5.5",
      "claude-sonnet-5-5[1m]",
      "opus",
      "fable",
      "haiku",
    ])
      expect(acceptsThinkingDisable(route)).toBe(false);

    for (const route of [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-4-5",
    ])
      expect(acceptsThinkingDisable(route)).toBe(true);
    expect(supportsAdaptiveThinking("claude-haiku-4-5")).toBe(false);
    expect(supportsAdaptiveThinking("haiku")).toBe(true);
  });
});

describe("Claude Code status", () => {
  test("ignores shared config overrides for account-local CLI processes", () => {
    const dir = dataDir();

    const options = claudeCodeOptions(
      dir,
      env({
        CRUMBLE_CLAUDE_CONFIG_DIR: "/shared/crumble-claude",
        CLAUDE_CONFIG_DIR: "/shared/claude",
      }),
    );

    expect(options.configDir).toBe(join(dir, "claude"));
    expect(options.workDir).toBe(join(dir, "claude-work"));
    expect(childEnv(options)["CLAUDE_CONFIG_DIR"]).toBe(join(dir, "claude"));
  });

  test("reports a missing CLI with the install hint", async () => {
    const options = claudeCodeOptions(
      dataDir(),
      env({ CRUMBLE_CLAUDE_COMMAND: "/nonexistent/claude" }),
    );

    expect(await claudeCodeStatus(options)).toMatchObject({
      status: "cli_missing",
    });
  });

  test("refuses an unqualified version", async () => {
    const options = claudeCodeOptions(
      dataDir({ FAKE_VERSION: "2.1.200" }),
      env(),
    );

    expect(await claudeCodeStatus(options)).toMatchObject({
      status: "unsupported_version",
      cliVersion: "2.1.200",
    });
  });

  test("reports signed out with the sign-in command for Crumble's own config directory", async () => {
    const dir = dataDir({ FAKE_LOGGED_IN: "0" });
    const status = await claudeCodeStatus(claudeCodeOptions(dir, env()));

    expect(status.status).toBe("signed_out");

    const external = await claudeCodePlugin(
      dir,
      env(),
    ).providers?.[0]?.externalAuth?.();

    expect(external?.signInCommand).toBe(
      `CLAUDE_CONFIG_DIR="${join(dir, "claude")}" ${FAKE} auth login`,
    );
  });

  test("reports signed in with the plan", async () => {
    expect(await claudeCodeStatus(claudeCodeOptions(dataDir(), env()))).toEqual(
      {
        status: "signed_in",
        cliVersion: "2.1.309",
        plan: "Claude Max",
      },
    );
  });

  test("keeps API keys, base URLs, and Crumble's secrets out of the CLI's environment", () => {
    const options = claudeCodeOptions(
      "/data",
      env({
        ANTHROPIC_API_KEY: "sk",
        ANTHROPIC_BASE_URL: "https://x.example",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CRUMBLE_TOKEN: "t",
        HTTPS_PROXY: "http://proxy:3128",
        CRUMBLE_CLAUDE_TELEMETRY: "off",
      }),
    );

    const child = childEnv(options);

    expect(child["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(child["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(child["CLAUDE_CODE_USE_BEDROCK"]).toBeUndefined();
    expect(child["CRUMBLE_TOKEN"]).toBeUndefined();
    expect(child["HTTPS_PROXY"]).toBe("http://proxy:3128");
    expect(child["CLAUDE_CONFIG_DIR"]).toBe("/data/claude");
    expect(child["USER"]).toBeTruthy();
    expect(child["DISABLE_AUTOUPDATER"]).toBe("1");
    expect(child["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]).toBe("1");
  });
});

const provider = z.object({
  provider: z.string(),
  configured: z.boolean(),
  authMethods: z.array(z.json()),
  externalAuth: z
    .object({
      status: z.string(),
      signInCommand: z.string().nullable(),
      signOutCommand: z.string().nullable(),
    })
    .nullable(),
});

const token = "x".repeat(32);

function api(fake: Record<string, string>) {
  const dir = dataDir(fake);
  const store = new Store(dir);
  const plugin = claudeCodePlugin(dir, env());
  const providers = pluginProviders([plugin]);
  const providerAuth = standaloneSignIns(store.runtime, providers);
  // SAFETY: provider routes never reach the runtime.

  const service = standaloneBots(store, {} as AgentRuntime);

  const scheduler = standaloneScheduler(store.runtime, (a, p, r, s) =>
    service.dispatch(a, p, r, s),
  );

  const app = createAPI(service, scheduler, token, undefined, {
    providerAuth,
    externalAuth: new Map(
      providers.flatMap(({ provider: item, externalAuth }) =>
        externalAuth ? [[item.id, externalAuth]] : [],
      ),
    ),
  });

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}` },
    });

  return { store, request };
}

describe("Claude Code in the provider API", () => {
  test("lists its sign-in state instead of sign-in methods", async () => {
    const { store, request } = api({ FAKE_LOGGED_IN: "0" });

    const listed = z
      .array(provider)
      .parse(await (await request("/v1/providers")).json());

    const claude = listed.find((item) => item.provider === "claude-code");

    expect(claude).toMatchObject({ configured: false, authMethods: [] });
    expect(claude?.externalAuth?.status).toBe("signed_out");
    expect(claude?.externalAuth?.signInCommand).toContain("auth login");
    expect(
      listed.find((item) => item.provider === "openai")?.externalAuth,
    ).toBeNull();
    store.close();
  });

  test("is configured once Claude Code is signed in", async () => {
    const { store, request } = api({});

    const listed = z
      .array(provider)
      .parse(await (await request("/v1/providers")).json());

    expect(
      listed.find((item) => item.provider === "claude-code"),
    ).toMatchObject({
      configured: true,
      externalAuth: { status: "signed_in" },
    });
    store.close();
  });

  test("refuses to remove a credential Crumble does not hold", async () => {
    const { store, request } = api({});

    const response = await request("/v1/providers/claude-code", {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain("auth logout");
    store.close();
  });
});
