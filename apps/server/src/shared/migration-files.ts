import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { z } from "zod";

const Statements = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    breakpoints: z.array(z.number().int().nonnegative()),
  })
  .strict();
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export const readCommentFreeMigrations = (migrationsFolder: string) =>
  readMigrationFiles({ migrationsFolder }).map((migration) => {
    const metadataPath = join(
      migrationsFolder,
      migration.name,
      "statements.json",
    );
    if (!existsSync(metadataPath)) {
      return migration;
    }
    const metadata = Statements.parse(
      JSON.parse(readFileSync(metadataPath, "utf8")),
    );
    const source = readFileSync(
      join(migrationsFolder, migration.name, "migration.sql"),
      "utf8",
    );
    if (sha256(source) !== metadata.sourceHash) {
      throw new Error(`Migration source hash mismatch: ${migration.name}`);
    }
    let previous = 0;
    const bounds = [...metadata.breakpoints, source.length];
    for (const offset of metadata.breakpoints) {
      if (offset <= previous || offset >= source.length) {
        throw new Error(`Invalid statement breakpoint in ${migration.name}`);
      }
      previous = offset;
    }
    let start = 0;
    const sql = bounds.map((end) => {
      const statement = source.slice(start, end);
      start = end;
      return statement;
    });
    return { ...migration, sql, hash: metadata.hash };
  });
