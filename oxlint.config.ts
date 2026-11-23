import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  ...cloudflare,
  rules: {
    ...cloudflare.rules,
    "no-empty": ["error", { allowEmptyCatch: true }],
  },
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "apps/web/components/ui/**",
    "apps/web/hooks/**",
    "**/*.test.ts",
  ],
});
