import { openAPIDocument } from "./api-contract";

const target = new URL("../openapi/openapi.json", import.meta.url);
const generated = `${JSON.stringify(openAPIDocument(), null, 2)}\n`;
const args = Bun.argv.slice(2);

if (args.length === 0) {
  await Bun.write(target, generated);
  console.log("Generated openapi/openapi.json");
} else if (args.length === 1 && args[0] === "--check") {
  const file = Bun.file(target);

  if (!(await file.exists()) || (await file.text()) !== generated) {
    console.error(
      "OpenAPI contract is stale. Run bun run openapi:generate and include openapi/openapi.json in your change.",
    );
    process.exitCode = 1;
  } else {
    console.log("OpenAPI contract is current");
  }
} else {
  console.error("Usage: bun src/openapi.ts [--check]");
  process.exitCode = 1;
}
