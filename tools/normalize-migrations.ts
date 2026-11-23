import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const marker = "--> statement-breakpoint";
const Metadata = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    breakpoints: z.array(z.number().int().nonnegative()),
  })
  .strict();
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function stripComments(sql: string): string {
  let output = "";
  let quote = "";
  for (let i = 0; i < sql.length;) {
    const c = sql[i] ?? "";
    if (quote) {
      output += c;
      if (c === quote) {
        if (sql[i + 1] === quote) {
          output += sql[++i] ?? "";
        } else {
          quote = "";
        }
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      output += c;
      i++;
      continue;
    }
    if (c === "[") {
      quote = "]";
      output += c;
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") {
        i++;
      }
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      output += " ";
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        if (sql[i] === "\n" || sql[i] === "\r") {
          output += sql[i];
        }
        i++;
      }
      i = Math.min(sql.length, i + 2);
      continue;
    }
    output += c;
    i++;
  }
  return output;
}

function normalize(file: string) {
  const manifest = `${file.slice(0, -"migration.sql".length)}statements.json`;
  const raw = readFileSync(file, "utf8");
  if (existsSync(manifest)) {
    const metadata = Metadata.parse(JSON.parse(readFileSync(manifest, "utf8")));
    if (sha256(raw) !== metadata.sourceHash) {
      throw new Error(`Normalized source hash mismatch: ${file}`);
    }
    return;
  }
  const parts = raw.split(marker).map(stripComments);
  const breakpoints: Array<number> = [];
  let source = "";
  parts.forEach((part, index) => {
    source += part;
    if (index < parts.length - 1) {
      breakpoints.push(source.length);
    }
  });
  const metadata = {
    hash: sha256(raw),
    sourceHash: sha256(source),
    breakpoints,
  };
  writeFileSync(file, source);
  writeFileSync(manifest, `${JSON.stringify(metadata, null, 2)}\n`);
}

function visit(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(path);
    } else if (entry.name === "migration.sql") {
      normalize(path);
    }
  }
}

visit(join(import.meta.dir, "../apps/server/drizzle"));
