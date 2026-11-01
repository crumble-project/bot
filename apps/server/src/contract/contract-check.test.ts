import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compareContracts } from "./contract-check";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-contract-"));
  dirs.push(dir);

  return dir;
};

let tools = "";
const previousTool = process.env["OASDIFF"];

// Stands in for oasdiff 1.35.0, which CI installs: it reports no breaking HTTP or event changes.
beforeAll(async () => {
  tools = mkdtempSync(join(tmpdir(), "bot-oasdiff-"));
  const tool = join(tools, "oasdiff");

  await Bun.write(
    tool,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "oasdiff version 1.35.0"; elif [ "$1" = "breaking" ]; then echo "[]"; fi\n',
  );
  chmodSync(tool, 0o755);
  process.env["OASDIFF"] = tool;
});

afterAll(() => {
  rmSync(tools, { recursive: true, force: true });

  if (previousTool === undefined) delete process.env["OASDIFF"];
  else process.env["OASDIFF"] = previousTool;
});

const schema = (title: string) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title,
  type: "object",
});

async function contract(version: string, schemas: string[]) {
  const dir = temp();

  await Bun.write(
    join(dir, "openapi.json"),
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Crumble", version },
      paths: {},
    }),
  );

  for (const name of schemas)
    await Bun.write(join(dir, name), JSON.stringify(schema(name)));

  return dir;
}

const reports = () => {
  const dir = join(temp(), "reports");
  mkdirSync(dir);

  return dir;
};

test("accepts an added event schema without a version increase", async () => {
  const base = await contract("1.4.0", ["chat-snapshot.schema.json"]);

  const current = await contract("1.4.0", [
    "chat-snapshot.schema.json",
    "group-chat-snapshot.schema.json",
  ]);

  await compareContracts(base, current, reports());
});

test("rejects a removed event schema", async () => {
  const base = await contract("1.4.0", [
    "chat-snapshot.schema.json",
    "heartbeat.schema.json",
  ]);

  const current = await contract("1.4.0", ["chat-snapshot.schema.json"]);

  await expect(compareContracts(base, current, reports())).rejects.toThrow(
    "removed event schemas: heartbeat.schema.json",
  );
});

test("rejects breaking changes reported by oasdiff", async () => {
  const base = await contract("1.4.0", ["chat-snapshot.schema.json"]);

  const current = await contract("1.4.0", ["chat-snapshot.schema.json"]);
  const tool = join(tools, "breaking-oasdiff");
  await Bun.write(
    tool,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "oasdiff version 1.35.0"; elif [ "$1" = "breaking" ]; then echo '[{"id":"response-property-removed"}]'; fi
`,
  );
  chmodSync(tool, 0o755);
  process.env["OASDIFF"] = tool;

  try {
    await expect(compareContracts(base, current, reports())).rejects.toThrow(
      "Breaking HTTP or event changes detected",
    );
  } finally {
    process.env["OASDIFF"] = join(tools, "oasdiff");
  }
});
