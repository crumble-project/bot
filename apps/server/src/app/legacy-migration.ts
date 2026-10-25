/* oxlint-disable anti-slop/require-readable-spacing */

import { Database } from "bun:sqlite";
import lockfile from "proper-lockfile";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { authUsers } from "./auth-schema";

const MARKER = ".legacy-migration.json";
const LEGACY_PATHS = [
  ".secret.key",
  "store.sqlite",
  "store.sqlite-shm",
  "store.sqlite-wal",
  "push.sqlite",
  "push.sqlite-shm",
  "push.sqlite-wal",
  "agents",
  "groups",
  "claude",
  "claude-work",
] as const;

export type LegacyMigrationResult = {
  userId: string;
  email: string;
  target: string;
  copied: string[];
  workspaceWarning: string;
};

function fail(message: string): never {
  throw new Error(`Legacy migration: ${message}`);
}

function secureTree(path: string) {
  const info = lstatSync(path);
  if (info.isSymbolicLink())
    fail(`refusing symbolic link in migration input: ${path}`);
  chmodSync(path, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) secureTree(join(path, entry));
  }
}

function copyLegacyPath(source: string, target: string) {
  const info = lstatSync(source);
  if (info.isSymbolicLink())
    fail(`refusing symbolic link in migration input: ${source}`);
  cpSync(source, target, {
    recursive: info.isDirectory(),
    preserveTimestamps: true,
  });
  secureTree(target);
}

function legacyUser(
  dataDir: string,
  email: string,
): { id: string; email: string } {
  const authPath = join(dataDir, "auth.sqlite");
  if (!existsSync(authPath))
    fail("auth.sqlite is missing; create the account first");
  let db: Database | undefined;
  try {
    db = new Database(authPath, { readonly: true });

    const row = drizzle({ client: db })
      .select({ id: authUsers.id, email: authUsers.email })
      .from(authUsers)
      .where(eq(sql`lower(${authUsers.email})`, sql`lower(${email})`))
      .limit(2)
      .all();
    if (row.length === 0) fail(`no Better Auth user exists for ${email}`);
    if (row.length > 1) fail(`multiple Better Auth users match ${email}`);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(row[0]!.id))
      fail("target account has an invalid id");
    return row[0]!;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Legacy migration:"))
      throw error;
    fail(
      `cannot read auth.sqlite: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    db?.close();
  }
  throw new Error("unreachable");
}

function validateSource(dataDir: string) {
  for (const name of [".secret.key", "store.sqlite"]) {
    if (!existsSync(join(dataDir, name)))
      fail(`${name} is missing from the legacy data directory`);
  }
  const sourcePaths = LEGACY_PATHS.filter((name) =>
    existsSync(join(dataDir, name)),
  );
  for (const name of sourcePaths) {
    const info = lstatSync(join(dataDir, name));
    if (info.isSymbolicLink())
      fail(`refusing symbolic link in migration input: ${name}`);
  }
  return sourcePaths;
}

/** Copy the single-user root store into an already-created Better Auth account. */
export async function migrateLegacyData(options: {
  dataDir: string;
  email: string;
}): Promise<LegacyMigrationResult> {
  const dataDir = resolve(options.dataDir);
  const email = options.email.trim();
  if (!email) fail("email is required");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(dataDir, {
    stale: 30000,
    update: 10000,
    retries: 0,
  });
  try {
    const user = legacyUser(dataDir, email);
    const sourcePaths = validateSource(dataDir);
    const markerPath = join(dataDir, MARKER);
    if (existsSync(markerPath)) {
      // SAFETY: marker is written by this module and only used for its userId field.
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
        userId?: string;
      };
      if (marker.userId === user.id)
        fail(`legacy data has already been migrated to ${user.id}`);
      fail("legacy data has already been migrated");
    }
    const usersDir = join(dataDir, "users");
    const target = join(usersDir, user.id);
    if (existsSync(target)) {
      if (readdirSync(target).length > 0)
        fail(`target users/${user.id} already exists and is not empty`);
      rmSync(target, { recursive: true, force: true });
    }

    mkdirSync(usersDir, { recursive: true, mode: 0o700 });
    const stage = join(usersDir, `.legacy-${user.id}-${randomUUID()}`);
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    try {
      for (const name of sourcePaths)
        copyLegacyPath(join(dataDir, name), join(stage, name));
      writeFileSync(
        join(stage, MARKER),
        JSON.stringify({
          source: dataDir,
          userId: user.id,
          email: user.email,
          migratedAt: new Date().toISOString(),
        }) + "\n",
        { mode: 0o600 },
      );
      renameSync(stage, target);
      const markerTemp = `${markerPath}.${randomUUID()}.tmp`;
      writeFileSync(
        markerTemp,
        JSON.stringify({
          source: dataDir,
          userId: user.id,
          email: user.email,
          migratedAt: new Date().toISOString(),
        }) + "\n",
        { mode: 0o600 },
      );
      renameSync(markerTemp, markerPath);
    } catch (error) {
      if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
      throw error;
    }
    return {
      userId: user.id,
      email: user.email,
      target,
      copied: sourcePaths,
      workspaceWarning:
        "Legacy workspace volumes named crumble-agentId are not migrated; attach or recreate them per user.",
    };
  } finally {
    await release();
  }
}

export const legacyMigrationPaths = LEGACY_PATHS;
