import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
import { getMigrations } from "better-auth/db/migration";

export async function createAuth(dataDir: string, baseURL: string) {
  const secretPath = join(dataDir, ".auth-secret");

  if (!existsSync(secretPath))
    writeFileSync(secretPath, randomBytes(48).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  chmodSync(secretPath, 0o600);
  const database = new Database(join(dataDir, "auth.sqlite"));
  database.run("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

  const options = {
    appName: "Crumble",
    baseURL,
    secret: readFileSync(secretPath, "utf8").trim(),
    database,
    trustedOrigins: [baseURL],
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database" },
    plugins: [bearer()],
  } satisfies BetterAuthOptions;

  try {
    const { runMigrations } = await getMigrations(options);
    await runMigrations();
    const auth = betterAuth(options);

    return {
      auth,
      hasUser: (id: string) =>
        Boolean(database.query('SELECT id FROM "user" WHERE id = ?').get(id)),
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
