import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Agents follow paths in steering files without checking them first, so a moved file must fail the build.
const files = Bun.spawnSync([
  "git",
  "ls-files",
  "AGENTS.md",
  "**/AGENTS.md",
  "CLAUDE.md",
  "**/CLAUDE.md",
])
  .stdout.toString()
  .split("\n")
  .filter(Boolean);

// Package names such as `@scope/name` are not paths.
const looksLikePath = (token: string) =>
  /^[\w.-]+(\/[\w.@-]+)+\/?$|^[\w-]+\.(md|ts|tsx|json|toml|yaml)$/.test(token);

const missing = files.flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/`([^`\s]+)`/g)].flatMap(
    ([, token = ""]) =>
      looksLikePath(token) && !existsSync(path.join(path.dirname(file), token))
        ? [`${file}: \`${token}\` does not exist`]
        : [],
  ),
);

if (missing.length > 0) {
  console.error(missing.join("\n"));
  process.exit(1);
}
