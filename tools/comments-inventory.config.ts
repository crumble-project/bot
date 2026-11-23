import { defineConfig } from "oxlint";

export default defineConfig({
  categories: { correctness: "off" },
  jsPlugins: ["./comment-lint.mjs"],
  rules: { "crumble-comments/inventory": "warn" },
});
