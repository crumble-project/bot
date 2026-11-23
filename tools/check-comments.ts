import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sourceComments, sourceSyntax } from "./source-comments";
import { inlineScripts } from "./inline-scripts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--inventory")) {
  process.stderr.write("Usage: bun tools/check-comments.ts [--inventory]\n");
  process.exit(1);
}
const inventory = args[0] === "--inventory";
const tracked = Bun.spawnSync(
  ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root },
);
if (tracked.exitCode !== 0) {
  process.stderr.write(tracked.stderr);
  process.exit(tracked.exitCode);
}
const allFiles = [...new Set(tracked.stdout.toString().split("\0"))].filter(
  (file) => file && existsSync(path.join(root, file)),
);
const files = allFiles.filter((file) => /\.[cm]?[jt]sx?$/.test(file));
const sourceFiles = allFiles.filter((file) => sourceSyntax(file));
const sourceDiagnostics = sourceFiles.flatMap((filename) => {
  const source = readFileSync(path.join(root, filename), "utf8");
  return sourceComments(filename, source).map(({ offset, length }) => {
    const text = source.slice(offset, offset + length);
    const before = source.slice(0, offset);
    return {
      filename,
      code: "crumble-comments(inventory)",
      severity: "warning",
      message: JSON.stringify({
        text,
        hash: createHash("sha256").update(text).digest("hex"),
      }),
      labels: [
        {
          span: {
            offset: Buffer.byteLength(before),
            length: Buffer.byteLength(text),
            line: before.split("\n").length,
            column: offset - before.lastIndexOf("\n"),
          },
        },
      ],
    };
  });
});
const baseline = z
  .record(z.string(), z.array(z.string()))
  .parse(
    JSON.parse(
      readFileSync(new URL("./comment-baseline.json", import.meta.url), "utf8"),
    ),
  );
const current = new Set(files);
const obsolete = Object.keys(baseline).filter((file) => !current.has(file));
if (obsolete.length) {
  process.stderr.write(
    `Remove deleted files from tools/comment-baseline.json:\n${obsolete.join("\n")}\n`,
  );
  process.exit(1);
}
if (!files.length) {
  process.exit(0);
}
const inlineDirectory = mkdtempSync(
  path.join(tmpdir(), "crumble-comment-scripts-"),
);
const inlineOrigins = new Map<string, { filename: string; prefix: string }>();
for (const filename of sourceFiles.filter((file) => file.endsWith(".html"))) {
  const source = readFileSync(path.join(root, filename), "utf8");
  for (const script of inlineScripts(source)) {
    const file = path.join(inlineDirectory, `inline-${inlineOrigins.size}.js`);
    writeFileSync(file, script.source);
    inlineOrigins.set(file, {
      filename,
      prefix: source.slice(0, script.offset),
    });
  }
}
const result = (() => {
  try {
    return Bun.spawnSync(
      [
        "bunx",
        "--no-install",
        "oxlint",
        "--config",
        inventory
          ? "tools/comments-inventory.config.ts"
          : "tools/comments.config.ts",
        "--disable-nested-config",
        "--no-ignore",
        "--format",
        "json",
        ...(!inventory ? ["--deny-warnings"] : []),
        ...files,
        ...inlineOrigins.keys(),
      ],
      { cwd: root, stdout: "pipe", stderr: "inherit" },
    );
  } finally {
    rmSync(inlineDirectory, { recursive: true, force: true });
  }
})();
if (!result.stdout) {
  throw new Error("Oxlint did not return a comment report");
}
const report = z
  .object({
    diagnostics: z.array(
      z
        .object({
          filename: z.string(),
          message: z.string(),
          code: z.string().optional(),
          labels: z
            .array(
              z
                .object({
                  span: z
                    .object({
                      offset: z.number(),
                      length: z.number(),
                      line: z.number(),
                      column: z.number(),
                    })
                    .passthrough(),
                })
                .passthrough(),
            )
            .default([]),
        })
        .passthrough(),
    ),
    number_of_files: z.number(),
  })
  .passthrough()
  .parse(JSON.parse(result.stdout.toString()));
const diagnostics = [
  ...report.diagnostics.map((diagnostic) => {
    const origin = inlineOrigins.get(path.resolve(root, diagnostic.filename));
    if (!origin) {
      return diagnostic;
    }
    const prefixLines = origin.prefix.split("\n");
    return {
      ...diagnostic,
      filename: origin.filename,
      labels: diagnostic.labels.map((label) => ({
        ...label,
        span: {
          ...label.span,
          offset: label.span.offset + Buffer.byteLength(origin.prefix),
          line: label.span.line + prefixLines.length - 1,
          column:
            label.span.column +
            (label.span.line === 1
              ? Buffer.byteLength(prefixLines.at(-1) ?? "")
              : 0),
        },
      })),
    };
  }),
  ...sourceDiagnostics,
];
if (inventory) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ...report,
        number_of_files: files.length + sourceFiles.length,
        diagnostics,
      },
      null,
      2,
    )}\n`,
  );
} else {
  for (const diagnostic of diagnostics) {
    const location = diagnostic.labels[0]?.span;
    process.stderr.write(
      `${diagnostic.filename}:${location?.line}:${location?.column}: ${diagnostic.message}\n`,
    );
  }
  if (!diagnostics.length && result.exitCode === 0) {
    process.stdout.write(
      `Checked ${files.length + sourceFiles.length} source files: zero comments.\n`,
    );
  }
}
process.exit(
  result.exitCode || (!inventory && sourceDiagnostics.length ? 1 : 0),
);
