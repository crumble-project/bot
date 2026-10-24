import { migrateLegacyData } from "../src/legacy-migration";

const dataDir = process.env.CRUMBLE_DATA_DIR ?? "./data";
const email = process.argv[2]?.trim();

if (!email) {
  console.error(
    "Usage: CRUMBLE_DATA_DIR=./data bun tools/assign-legacy-owner.ts <email>",
  );
  process.exit(2);
}

try {
  const result = await migrateLegacyData({ dataDir, email });
  console.log(`Migrated legacy data to users/${result.userId}.`);
  console.log(result.workspaceWarning);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
