import { defineConfig } from "drizzle-kit";

// Each account's push database (push.sqlite).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/push/schema.ts",
  out: "./drizzle/push",
});
