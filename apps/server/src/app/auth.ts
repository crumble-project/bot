import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { passkey } from "@better-auth/passkey";
import { bearer } from "better-auth/plugins/bearer";
import { getMigrations } from "better-auth/db/migration";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { authUsers } from "./auth-schema";

/**
 * The origin passkeys are bound to. WebAuthn rejects IP addresses as relying
 * party IDs, so a loopback origin maps to `localhost` on the same port.
 */
export function passkeyOriginFor(baseURL: string) {
  const url = new URL(baseURL);

  if (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    url.hostname = "localhost";

  return url.origin;
}

/** The browser origins allowed to call the server: its own, and the one passkeys are bound to. */
export function trustedOriginsFor(baseURL: string) {
  return [...new Set([new URL(baseURL).origin, passkeyOriginFor(baseURL)])];
}

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
  const passkeyOrigin = passkeyOriginFor(baseURL);

  const options = {
    appName: "Crumble",
    baseURL,
    secret: readFileSync(secretPath, "utf8").trim(),
    database,
    trustedOrigins: trustedOriginsFor(baseURL),
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database" },
    plugins: [
      bearer(),
      passkey({
        rpID: new URL(passkeyOrigin).hostname,
        rpName: "Crumble",
        origin: passkeyOrigin,
      }),
    ],
  } satisfies BetterAuthOptions;

  try {
    const { runMigrations } = await getMigrations(options);
    await runMigrations();
    const auth = betterAuth(options);
    const users = drizzle({ client: database });

    return {
      auth,
      hasUser: (id: string) =>
        users
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(eq(authUsers.id, id))
          .get() !== undefined,
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
