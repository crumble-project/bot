import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/push/schema.ts",
  out: "./drizzle/push",
});
