import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountModels } from "../providers/providers";
import { DEFAULT_SERVER_SETTINGS } from "./server-settings";
import { createTenant } from "./tenant";

const original = process.env["OPENAI_API_KEY"];

afterEach(() => {
  if (original === undefined) delete process.env["OPENAI_API_KEY"];
  else process.env["OPENAI_API_KEY"] = original;
});

test("tenant provider models do not resolve ambient host credentials", async () => {
  process.env["OPENAI_API_KEY"] = "host-secret";

  const models = accountModels(undefined, []);

  expect(await models.getAuth("openai")).toBeUndefined();
});

type Tenant = Awaited<ReturnType<typeof createTenant>>;

type ClaudeProvider = {
  provider: string;
  configured: boolean;
  externalAuth: {
    status: string;
    signInCommand: string | null;
    signOutCommand: string | null;
  } | null;
};

async function claudeProvider(tenant: Tenant) {
  const response = await tenant.app.request("/v1/providers", {
    headers: { authorization: `Bearer ${tenant.token}` },
  });

  expect(response.status).toBe(200);

  // SAFETY: the provider API response is narrowed to the fields asserted below.
  const providers = (await response.json()) as ClaudeProvider[];

  return providers.find((item) => item.provider === "claude-code");
}

function claudeState(configDir: string, loggedIn: string) {
  mkdirSync(configDir, { recursive: true, mode: 0o755 });
  writeFileSync(
    join(configDir, "fake.json"),
    JSON.stringify({ FAKE_LOGGED_IN: loggedIn }),
  );
}

function claudeSetup(root: string) {
  const skillsDir = join(root, "skills");
  const sharedConfig = join(root, "shared-claude");
  const firstDir = join(root, "first");
  const secondDir = join(root, "second");

  mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  claudeState(sharedConfig, "1");
  claudeState(join(firstDir, "claude"), "1");
  claudeState(join(secondDir, "claude"), "0");

  return { skillsDir, sharedConfig, firstDir, secondDir };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function expectCommandsUse(
  configDir: string,
  command: string,
  provider: ClaudeProvider | undefined,
) {
  const prefix = `CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)} ${command}`;

  expect(provider?.externalAuth).toMatchObject({
    signInCommand: `${prefix} auth login`,
    signOutCommand: `${prefix} auth logout`,
  });
}

test.serial(
  "Claude Code sign-in state and config stay isolated per tenant",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "crumble-tenant-claude-"));
    const { skillsDir, sharedConfig, firstDir, secondDir } = claudeSetup(root);
    const fake = join(import.meta.dir, "../../test/fixtures/fake-claude.ts");
    const command = process.env["CRUMBLE_CLAUDE_COMMAND"];
    const config = process.env["CRUMBLE_CLAUDE_CONFIG_DIR"];
    const skills = process.env["CRUMBLE_SKILLS_DIR"];
    let first: Tenant | undefined;
    let second: Tenant | undefined;

    try {
      chmodSync(fake, 0o755);
      process.env["CRUMBLE_CLAUDE_COMMAND"] = fake;
      process.env["CRUMBLE_CLAUDE_CONFIG_DIR"] = sharedConfig;
      process.env["CRUMBLE_SKILLS_DIR"] = skillsDir;

      first = await createTenant({
        dataDir: firstDir,
        tenantId: "first-user",
        skillsDir,
        serverSettings: () => DEFAULT_SERVER_SETTINGS,
        workspaceEnv: process.env,
      });
      second = await createTenant({
        dataDir: secondDir,
        tenantId: "second-user",
        skillsDir,
        serverSettings: () => DEFAULT_SERVER_SETTINGS,
        workspaceEnv: process.env,
      });

      expect(statSync(join(firstDir, "claude")).mode & 0o777).toBe(0o700);
      expect(statSync(join(secondDir, "claude")).mode & 0o777).toBe(0o700);

      const firstClaude = await claudeProvider(first);
      const secondClaude = await claudeProvider(second);

      expect(firstClaude).toMatchObject({
        configured: true,
        externalAuth: { status: "signed_in" },
      });
      expect(secondClaude).toMatchObject({
        configured: false,
        externalAuth: { status: "signed_out" },
      });
      expectCommandsUse(join(firstDir, "claude"), fake, firstClaude);
      expectCommandsUse(join(secondDir, "claude"), fake, secondClaude);
    } finally {
      await Promise.allSettled([first?.close(), second?.close()]);
      restoreEnv("CRUMBLE_CLAUDE_COMMAND", command);
      restoreEnv("CRUMBLE_CLAUDE_CONFIG_DIR", config);
      restoreEnv("CRUMBLE_SKILLS_DIR", skills);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
