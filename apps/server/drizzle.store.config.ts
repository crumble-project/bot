import { defineConfig } from "drizzle-kit";

// Each account's product database (store.sqlite); every feature keeps its tables in its own schema.ts.
export default defineConfig({
  dialect: "sqlite",
  schema: [
    "./src/bots/schema.ts",
    "./src/bots/execution-schema.ts",
    "./src/bot-desktop/schema.ts",
    "./src/credentials/schema.ts",
    "./src/group-chats/schema.ts",
    "./src/integrations/schema.ts",
    "./src/memory/schema.ts",
    "./src/providers/schema.ts",
    "./src/schedules/schema.ts",
    "./src/shared/schema.ts",
    "./src/skills/schema.ts",
  ],
  out: "./drizzle/store",
});
