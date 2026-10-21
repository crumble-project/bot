import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compareContracts, verifyBundle } from "../src/contract-release";

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
const previousTool = process.env.OASDIFF;

// Stands in for oasdiff 1.34.0, which CI installs: it reports no breaking HTTP or event changes.
beforeAll(async () => {
  tools = mkdtempSync(join(tmpdir(), "bot-oasdiff-"));
  const tool = join(tools, "oasdiff");

  await Bun.write(
    tool,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "oasdiff version 1.34.0"; elif [ "$1" = "breaking" ]; then echo "[]"; fi\n',
  );
  chmodSync(tool, 0o755);
  process.env.OASDIFF = tool;
});

afterAll(() => {
  rmSync(tools, { recursive: true, force: true });

  if (previousTool === undefined) delete process.env.OASDIFF;
  else process.env.OASDIFF = previousTool;
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

test("accepts an added event schema with a minor version increase", async () => {
  const base = await contract("1.4.0", ["chat-snapshot.schema.json"]);

  const current = await contract("1.5.0", [
    "chat-snapshot.schema.json",
    "group-chat-snapshot.schema.json",
  ]);

  await compareContracts(base, current, reports());
});

test("requires a version increase for an added event schema", async () => {
  const base = await contract("1.4.0", ["chat-snapshot.schema.json"]);

  const current = await contract("1.4.0", [
    "chat-snapshot.schema.json",
    "group-chat-snapshot.schema.json",
  ]);

  await expect(compareContracts(base, current, reports())).rejects.toThrow(
    "Changed contract requires a version increase",
  );
});

test("treats a removed event schema as breaking", async () => {
  const base = await contract("1.4.0", [
    "chat-snapshot.schema.json",
    "heartbeat.schema.json",
  ]);

  const current = await contract("1.5.0", ["chat-snapshot.schema.json"]);

  await expect(compareContracts(base, current, reports())).rejects.toThrow(
    "higher contract major version",
  );
  await compareContracts(
    base,
    await contract("2.0.0", ["chat-snapshot.schema.json"]),
    reports(),
  );
});

test("verifies a bundle by the event schemas it carries", async () => {
  const dir = await contract("1.4.0", [
    "chat-snapshot.schema.json",
    "group-chat-snapshot.schema.json",
  ]);

  await Bun.write(join(dir, "CHANGELOG.md"), "## Contract 1.4.0\n");
  await Bun.write(join(dir, "source-commit.txt"), `${"a".repeat(40)}\n`);

  const names = [
    "CHANGELOG.md",
    "chat-snapshot.schema.json",
    "group-chat-snapshot.schema.json",
    "openapi.json",
    "source-commit.txt",
  ];

  const sums = async (listed: string[]) => {
    const lines = await Promise.all(
      listed.map(
        async (name) =>
          `${createHash("sha256")
            .update(
              new Uint8Array(await Bun.file(join(dir, name)).arrayBuffer()),
            )
            .digest("hex")}  ${name}`,
      ),
    );

    await Bun.write(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  };

  await sums(names);
  await verifyBundle(dir);

  await sums(
    names.filter((name) => name !== "group-chat-snapshot.schema.json"),
  );
  await expect(verifyBundle(dir)).rejects.toThrow(
    "SHA256SUMS must cover exactly every payload asset",
  );
});
