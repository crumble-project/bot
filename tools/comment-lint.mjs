import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = JSON.parse(
  readFileSync(new URL("./comment-baseline.json", import.meta.url), "utf8"),
);

export const fingerprint = (text) =>
  createHash("sha256").update(text).digest("hex");

export default {
  meta: { name: "crumble-comments" },
  rules: {
    inventory: {
      meta: { type: "suggestion", schema: [] },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (comment.type === "Shebang") {
                continue;
              }
              const text = context.sourceCode.getText(comment);
              context.report({
                loc: comment.loc,
                message: JSON.stringify({ text, hash: fingerprint(text) }),
              });
            }
          },
        };
      },
    },
    "no-comments": {
      meta: {
        type: "suggestion",
        schema: [],
        messages: {
          added:
            "Comment is not grandfathered. Run /delete-comment; record decisions in docs/adr instead. Fingerprint: {{hash}}",
          removed:
            "Remove the obsolete comment fingerprint from tools/comment-baseline.json: {{hash}} ({{count}} occurrence(s)).",
        },
      },
      create(context) {
        return {
          Program(node) {
            const filename = path
              .relative(root, context.filename)
              .split(path.sep)
              .join("/");
            const remaining = new Map();
            for (const hash of baseline[filename] ?? []) {
              remaining.set(hash, (remaining.get(hash) ?? 0) + 1);
            }
            for (const comment of context.sourceCode.getAllComments()) {
              if (comment.type === "Shebang") {
                continue;
              }
              const hash = fingerprint(context.sourceCode.getText(comment));
              const count = remaining.get(hash) ?? 0;
              if (count > 0) {
                remaining.set(hash, count - 1);
              } else {
                context.report({
                  loc: comment.loc,
                  messageId: "added",
                  data: { hash },
                });
              }
            }
            for (const [hash, count] of remaining) {
              if (count > 0) {
                context.report({
                  node,
                  messageId: "removed",
                  data: { hash, count },
                });
              }
            }
          },
        };
      },
    },
  },
};
