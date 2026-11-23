import { readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "drizzle-kit";

const OTHER_DATABASES = new Set(["push"]);

const schema = readdirSync("./src", { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !OTHER_DATABASES.has(entry.name))
  .flatMap((folder) =>
    readdirSync(join("./src", folder.name))
      .filter((file) => /^schema(\.[a-z-]+)?\.ts$/.test(file))
      .map((file) => `./src/${folder.name}/${file}`),
  )
  .sort();

export default defineConfig({
  dialect: "sqlite",
  schema,
  out: "./drizzle/store",
});
