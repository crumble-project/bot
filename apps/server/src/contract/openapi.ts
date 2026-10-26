import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { openAPIDocument } from "./api-contract";
import {
  activityEvent,
  chatSnapshotResponse,
  desktopControlResponse,
  groupChatSnapshotResponse,
  heartbeatEvent,
  learnedEvent,
} from "./api-responses";

export const eventSchemas = {
  "chat-snapshot.schema.json": chatSnapshotResponse,
  "group-chat-snapshot.schema.json": groupChatSnapshotResponse,
  "activity-event.schema.json": activityEvent,
  "learned-event.schema.json": learnedEvent,
  "heartbeat.schema.json": heartbeatEvent,
  "desktop-control.schema.json": desktopControlResponse,
};

type ContractArtifacts = Record<string, string>;

export function contractArtifacts() {
  const artifacts: ContractArtifacts = {};
  artifacts["openapi.json"] = `${JSON.stringify(openAPIDocument(), null, 2)}\n`;

  for (const [name, schema] of Object.entries(eventSchemas)) {
    const document = z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io: "output",
      override: ({ jsonSchema }) => {
        if (
          jsonSchema.type === "object" &&
          jsonSchema.additionalProperties === false
        )
          jsonSchema.additionalProperties = true;
      },
    });

    artifacts[name] = `${JSON.stringify(document, null, 2)}\n`;
  }

  return artifacts;
}

function assertSourcesCommitted() {
  const status = Bun.spawnSync([
    "git",
    "status",
    "--porcelain",
    "--",
    "apps/server",
    "openapi",
    "CHANGELOG.md",
    "package.json",
    "bun.lock",
  ]);

  if (status.exitCode !== 0) throw new Error(status.stderr.toString());

  if (status.stdout.toString().trim())
    throw new Error(
      "Commit contract sources and artifacts before exporting a provenance bundle",
    );
}

function headCommit() {
  const source = Bun.spawnSync(["git", "rev-parse", "HEAD"]);

  if (source.exitCode !== 0) throw new Error(source.stderr.toString());

  return source.stdout.toString().trim();
}

export function changelogPayload(changelog: string, version: string) {
  const section = changelog
    .split(`## Contract ${version}\n`)[1]
    ?.split("\n## ")[0];

  if (!section?.trim())
    throw new Error(`Missing CHANGELOG.md section: Contract ${version}`);

  return `# Contract ${version}\n\n${section.trim()}\n`;
}

export function checksumManifest(artifacts: ContractArtifacts) {
  return Object.entries(artifacts)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([name, content]) =>
        `${createHash("sha256").update(content).digest("hex")}  ${name}\n`,
    )
    .join("");
}

async function writeBundle(output: string, artifacts: ContractArtifacts) {
  for (const name of Object.keys(artifacts)) {
    const target = join(output, name);

    if (await Bun.file(target).exists())
      throw new Error(`Refusing to overwrite ${target}`);
  }

  for (const [name, content] of Object.entries(artifacts)) {
    await Bun.write(join(output, name), content);
  }
}

export async function exportBundle(directory?: string) {
  assertSourcesCommitted();

  const output = directory
    ? resolve(directory)
    : await mkdtemp(join(tmpdir(), "crumble-contract-"));

  const artifacts = contractArtifacts();
  const commit = headCommit();

  const changelog = await Bun.file(
    new URL("../../../../CHANGELOG.md", import.meta.url),
  ).text();

  const version = openAPIDocument().info.version;

  artifacts["CHANGELOG.md"] = changelogPayload(changelog, version);
  artifacts["source-commit.txt"] = `${commit}\n`;
  artifacts["SHA256SUMS"] = checksumManifest(artifacts);

  await writeBundle(output, artifacts);
  console.log(output);

  return output;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);

  if (args[0] === "--bundle" && args.length <= 2) {
    await exportBundle(args[1]);
  } else if (
    args.length === 0 ||
    (args.length === 1 && args[0] === "--check")
  ) {
    let stale = false;

    for (const [name, content] of Object.entries(contractArtifacts())) {
      const target = new URL(`../../../../openapi/${name}`, import.meta.url);

      if (args[0] === "--check") {
        if (
          !(await Bun.file(target).exists()) ||
          (await Bun.file(target).text()) !== content
        ) {
          console.error(
            `Stale contract artifact: openapi/${name}. Run bun run openapi:generate.`,
          );
          stale = true;
        }
      } else {
        await Bun.write(target, content);
        console.log(`Generated openapi/${name}`);
      }
    }

    if (stale) process.exitCode = 1;
  } else {
    console.error(
      "Usage: bun apps/server/src/contract/openapi.ts [--check | --bundle [DIRECTORY]]",
    );
    process.exitCode = 1;
  }
}
