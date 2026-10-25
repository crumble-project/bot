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
import { providerModels } from "../src/providers";
import { createTenant } from "../src/tenant";

const original = process.env["OPENAI_API_KEY"];

afterEach(() => {
  if (original === undefined) delete process.env["OPENAI_API_KEY"];
  else process.env["OPENAI_API_KEY"] = original;
});

test("tenant provider models do not resolve ambient host credentials", async () => {
  process.env["OPENAI_API_KEY"] = "host-secret";

  const models = providerModels(undefined, [], { allowAmbientEnv: false });

  expect(await models.getAuth("openai")).toBeUndefined();
});

test.serial(
  "Claude Code sign-in state and config stay isolated per tenant",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "crumble-tenant-claude-"));
    const skillsDir = join(root, "skills");
    const sharedConfig = join(root, "shared-claude");
    const firstDir = join(root, "first");
    const secondDir = join(root, "second");
    const fake = join(import.meta.dir, "fixtures", "fake-claude.ts");
    const originalCommand = process.env["CRUMBLE_CLAUDE_COMMAND"];
    const originalConfig = process.env["CRUMBLE_CLAUDE_CONFIG_DIR"];
    const originalSkills = process.env["CRUMBLE_SKILLS_DIR"];
    let first: Awaited<ReturnType<typeof createTenant>> | undefined;
    let second: Awaited<ReturnType<typeof createTenant>> | undefined;

    try {
      mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
      mkdirSync(sharedConfig, { recursive: true, mode: 0o700 });
      mkdirSync(join(firstDir, "claude"), { recursive: true, mode: 0o755 });
      mkdirSync(join(secondDir, "claude"), { recursive: true, mode: 0o755 });
      writeFileSync(
        join(firstDir, "claude", "fake.json"),
        JSON.stringify({ FAKE_LOGGED_IN: "1" }),
      );
      writeFileSync(
        join(secondDir, "claude", "fake.json"),
        JSON.stringify({ FAKE_LOGGED_IN: "0" }),
      );
      writeFileSync(
        join(sharedConfig, "fake.json"),
        JSON.stringify({ FAKE_LOGGED_IN: "1" }),
      );
      chmodSync(fake, 0o755);

      process.env["CRUMBLE_CLAUDE_COMMAND"] = fake;
      process.env["CRUMBLE_CLAUDE_CONFIG_DIR"] = sharedConfig;
      process.env["CRUMBLE_SKILLS_DIR"] = skillsDir;

      first = await createTenant({
        dataDir: firstDir,
        tenantId: "first-user",
        skillsDir,
      });
      second = await createTenant({
        dataDir: secondDir,
        tenantId: "second-user",
        skillsDir,
      });

      expect(statSync(join(firstDir, "claude")).mode & 0o777).toBe(0o700);
      expect(statSync(join(secondDir, "claude")).mode & 0o777).toBe(0o700);

      const providers = async (tenant: typeof first) => {
        const response = await tenant!.app.request("/v1/providers", {
          headers: { authorization: `Bearer ${tenant!.token}` },
        });

        expect(response.status).toBe(200);

        // SAFETY: the provider API response is narrowed to the fields asserted below.
        return (await response.json()) as Array<{
          provider: string;
          configured: boolean;
          externalAuth: {
            status: string;
            signInCommand: string | null;
            signOutCommand: string | null;
          } | null;
        }>;
      };

      const firstClaude = (await providers(first)).find(
        (item) => item.provider === "claude-code",
      );

      const secondClaude = (await providers(second)).find(
        (item) => item.provider === "claude-code",
      );

      expect(firstClaude).toMatchObject({
        configured: true,
        externalAuth: { status: "signed_in" },
      });
      expect(secondClaude).toMatchObject({
        configured: false,
        externalAuth: { status: "signed_out" },
      });
      expect(firstClaude?.externalAuth?.signInCommand).toContain(
        `CLAUDE_CONFIG_DIR=${JSON.stringify(join(firstDir, "claude"))}`,
      );
      expect(firstClaude?.externalAuth?.signOutCommand).toContain(
        `CLAUDE_CONFIG_DIR=${JSON.stringify(join(firstDir, "claude"))}`,
      );
      expect(secondClaude?.externalAuth?.signInCommand).toContain(
        `CLAUDE_CONFIG_DIR=${JSON.stringify(join(secondDir, "claude"))}`,
      );
      expect(secondClaude?.externalAuth?.signOutCommand).toContain(
        `CLAUDE_CONFIG_DIR=${JSON.stringify(join(secondDir, "claude"))}`,
      );
      expect(firstClaude?.externalAuth?.signInCommand).not.toContain(
        sharedConfig,
      );
      expect(secondClaude?.externalAuth?.signInCommand).not.toContain(
        sharedConfig,
      );
    } finally {
      await Promise.allSettled([first?.close(), second?.close()]);

      if (originalCommand === undefined)
        delete process.env["CRUMBLE_CLAUDE_COMMAND"];
      else process.env["CRUMBLE_CLAUDE_COMMAND"] = originalCommand;

      if (originalConfig === undefined)
        delete process.env["CRUMBLE_CLAUDE_CONFIG_DIR"];
      else process.env["CRUMBLE_CLAUDE_CONFIG_DIR"] = originalConfig;

      if (originalSkills === undefined)
        delete process.env["CRUMBLE_SKILLS_DIR"];
      else process.env["CRUMBLE_SKILLS_DIR"] = originalSkills;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
