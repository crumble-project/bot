import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020";
import { z } from "zod";
import { eventSchemas, exportBundle } from "./openapi";
import { openAPIDocument } from "./api-contract";

const schemaNames = Object.keys(eventSchemas);

/** Every bundle carries these; its event schemas vary, because later contracts may add some. */
const fixedPayloadNames = ["openapi.json", "CHANGELOG.md", "source-commit.txt"];

const isEventSchema = (name: string) => name.endsWith(".schema.json");

/** The event schema files a contract directory carries, sorted. */
export async function eventSchemaNames(directory: string) {
  return (await readdir(directory)).filter(isEventSchema).sort();
}

const payloadNamesOf = (names: string[]) =>
  [...fixedPayloadNames, ...names].sort();

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const releaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  target_commitish: z.string(),
  assets: z.array(z.object({ name: z.string() })),
});

type Release = z.infer<typeof releaseSchema>;

const documentSchema = z.looseObject({
  info: z.looseObject({ version: z.string().regex(versionPattern) }),
});

const jsonSchema = z.record(z.string(), z.json());

function run(command: string[]) {
  const result = Bun.spawnSync(command, { env: process.env });

  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed (${result.exitCode}):\n${result.stderr.toString()}\n${result.stdout.toString()}`,
    );
  }

  return result.stdout.toString();
}

function gh(args: string[]) {
  return run(["gh", ...args]);
}

function versionParts(version: string) {
  if (!versionPattern.test(version))
    throw new Error(`Invalid stable contract version: ${version}`);

  return version.split(".").map((part) => BigInt(part));
}

function compareVersions(a: string, b: string) {
  const left = versionParts(a);
  const right = versionParts(b);

  for (const index of [0, 1, 2]) {
    if (left[index]! > right[index]!) return 1;

    if (left[index]! < right[index]!) return -1;
  }

  return 0;
}

async function documentVersion(directory: string) {
  return documentSchema.parse(
    await Bun.file(join(directory, "openapi.json")).json(),
  ).info.version;
}

export async function validateContract(directory: string) {
  await documentVersion(directory);
  const names = await eventSchemaNames(directory);
  await SwaggerParser.validate(join(directory, "openapi.json"), {
    resolve: { external: false },
  });

  const ajv = new Ajv2020({
    strict: false,
    validateFormats: false,
    allErrors: true,
  });

  for (const name of names) {
    const schema = jsonSchema.parse(
      await Bun.file(join(directory, name)).json(),
    );

    if (schema["$schema"] !== "https://json-schema.org/draft/2020-12/schema") {
      throw new Error(`${name} must use JSON Schema 2020-12`);
    }

    if (!ajv.validateSchema(schema))
      throw new Error(`${name}: ${ajv.errorsText()}`);
    ajv.compile(schema);
  }

  console.log(`Validated OpenAPI and JSON Schemas in ${directory}`);
}

export async function verifyBundle(directory: string) {
  const lines = (await Bun.file(join(directory, "SHA256SUMS")).text())
    .trim()
    .split("\n");

  const checksums = new Map<string, string>();

  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$/.exec(line);

    if (!match || checksums.has(match[2]!))
      throw new Error("Malformed or duplicate checksum entry");
    checksums.set(match[2]!, match[1]!);
  }

  const payloadNames = payloadNamesOf(await eventSchemaNames(directory));

  if (
    JSON.stringify([...checksums.keys()].sort()) !==
    JSON.stringify(payloadNames)
  ) {
    throw new Error("SHA256SUMS must cover exactly every payload asset");
  }

  for (const name of payloadNames) {
    const bytes = await Bun.file(join(directory, name)).arrayBuffer();

    if (
      createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !==
      checksums.get(name)
    ) {
      throw new Error(`Checksum mismatch: ${name}`);
    }
  }

  if (
    !/^[a-f0-9]{40}\n$/.test(
      await Bun.file(join(directory, "source-commit.txt")).text(),
    )
  ) {
    throw new Error("Invalid source commit");
  }
}

function listReleases(repo: string) {
  const pages = JSON.parse(
    gh(["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`]),
  );

  return z.array(z.array(releaseSchema)).parse(pages).flat();
}

function latestContract(releases: Release[]) {
  const published = releases.filter(
    (release) =>
      !release.draft &&
      !release.prerelease &&
      release.tag_name.startsWith("contract-v") &&
      versionPattern.test(release.tag_name.slice("contract-v".length)),
  );

  return published.sort((a, b) =>
    compareVersions(b.tag_name.slice(10), a.tag_name.slice(10)),
  )[0];
}

async function downloadRelease(repo: string, release: Release) {
  const directory = await mkdtemp(join(tmpdir(), "crumble-baseline-"));

  const names = [
    ...fixedPayloadNames,
    "SHA256SUMS",
    ...release.assets.map((asset) => asset.name).filter(isEventSchema),
  ];

  for (const name of names) {
    if (!release.assets.some((asset) => asset.name === name))
      throw new Error(`Missing released asset: ${name}`);
    gh([
      "release",
      "download",
      release.tag_name,
      "--repo",
      repo,
      "--pattern",
      name,
      "--dir",
      directory,
    ]);
  }

  await verifyBundle(directory);

  if (`contract-v${await documentVersion(directory)}` !== release.tag_name) {
    throw new Error("Release tag and OpenAPI version disagree");
  }

  return directory;
}

async function projectEvents(directory: string, destination: string) {
  const schemas: Record<string, z.infer<typeof jsonSchema>> = {};
  const paths: ReturnType<typeof openAPIDocument>["paths"] = {};

  for (const name of await eventSchemaNames(directory)) {
    const key = name.replace(".schema.json", "");
    const raw = await Bun.file(join(directory, name)).text();
    schemas[key] = jsonSchema.parse(
      JSON.parse(raw.replaceAll('"#/', `"#/components/schemas/${key}/`)),
    );
    paths[`/events/${key}`] = {
      get: {
        operationId: key,
        responses: {
          "200": {
            description:
              "SSE payload compatibility projection, not an HTTP endpoint",
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${key}` },
              },
            },
          },
        },
      },
    };
  }

  await Bun.write(
    destination,
    JSON.stringify(
      {
        openapi: "3.1.0",
        info: {
          title: "Crumble event response projection",
          version: await documentVersion(directory),
        },
        paths,
        components: { schemas },
      },
      null,
      2,
    ),
  );
}

export async function compareContracts(
  baseline: string,
  current: string,
  reports: string,
) {
  await mkdir(reports, { recursive: true });
  await validateContract(baseline);
  await validateContract(current);
  const tool = process.env["OASDIFF"] ?? "oasdiff";

  if (run([tool, "--version"]).trim() !== "oasdiff version 1.34.1") {
    throw new Error("Compatibility requires official oasdiff 1.34.1");
  }

  await projectEvents(baseline, join(reports, "events-base.json"));
  await projectEvents(current, join(reports, "events-current.json"));
  let breaking = false;

  for (const [name, base, revision] of [
    ["http", join(baseline, "openapi.json"), join(current, "openapi.json")],
    [
      "events",
      join(reports, "events-base.json"),
      join(reports, "events-current.json"),
    ],
  ]) {
    run([tool, "validate", base!, "--allow-external-refs=false"]);
    run([tool, "validate", revision!, "--allow-external-refs=false"]);

    const report = run([
      tool,
      "breaking",
      base!,
      revision!,
      "--format",
      "json",
      "--allow-external-refs=false",
    ]);

    await Bun.write(join(reports, `${name}-breaking.json`), report);

    const findings = z
      .array(z.looseObject({ id: z.string() }))
      .parse(JSON.parse(report));

    if (findings.length > 0) breaking = true;
  }

  const before = await documentVersion(baseline);
  const after = await documentVersion(current);
  const baseNames = await eventSchemaNames(baseline);
  const currentNames = await eventSchemaNames(current);

  // A removed event payload breaks clients that read it; an added one is a compatible change.
  if (baseNames.some((name) => !currentNames.includes(name))) breaking = true;
  let changed = currentNames.some((name) => !baseNames.includes(name));

  for (const name of [
    "openapi.json",
    ...baseNames.filter((name) => currentNames.includes(name)),
  ]) {
    if (
      (await Bun.file(join(baseline, name)).text()) !==
      (await Bun.file(join(current, name)).text())
    )
      changed = true;
  }

  if (compareVersions(after, before) < 0)
    throw new Error(`Contract version decreased: ${before} -> ${after}`);

  if (changed && compareVersions(after, before) <= 0)
    throw new Error("Changed contract requires a version increase");

  if (breaking && versionParts(after)[0]! <= versionParts(before)[0]!) {
    throw new Error(
      "Breaking HTTP or event changes require a higher contract major version",
    );
  }

  console.log(
    `Compatibility passed: ${before} -> ${after}${breaking ? " (new major)" : ""}`,
  );
}

async function checkPublished(repo: string, current: string, reports: string) {
  const releases = listReleases(repo);
  const latest = latestContract(releases);

  if (!latest) {
    console.log(
      "No published stable contract release found after successful release listing; skipping compatibility baseline only.",
    );
  } else {
    await compareContracts(
      await downloadRelease(repo, latest),
      current,
      reports,
    );
  }

  return releases;
}

async function assertTagTarget(repo: string, tag: string, commit: string) {
  const refs = z
    .array(
      z.object({
        ref: z.string(),
        object: z.object({ type: z.string(), sha: z.string() }),
      }),
    )
    .parse(
      JSON.parse(gh(["api", `repos/${repo}/git/matching-refs/tags/${tag}`])),
    );

  const ref = refs.find((entry) => entry.ref === `refs/tags/${tag}`);

  if (!ref) return;
  let object = ref.object;

  while (object.type === "tag") {
    object = z
      .object({ object: z.object({ type: z.string(), sha: z.string() }) })
      .parse(
        JSON.parse(gh(["api", `repos/${repo}/git/tags/${object.sha}`])),
      ).object;
  }

  if (object.type !== "commit" || object.sha !== commit)
    throw new Error(`Existing tag ${tag} targets another source commit`);
}

async function publish(repo: string, current: string, reports: string) {
  if (
    process.env["GITHUB_ACTIONS"] !== "true" ||
    process.env["GITHUB_REF"] !== "refs/heads/main" ||
    process.env["GITHUB_EVENT_NAME"] !== "push"
  ) {
    throw new Error("Publishing is restricted to the main push workflow");
  }

  await validateContract(current);
  const releases = await checkPublished(repo, current, reports);
  const version = await documentVersion(current);
  const tag = `contract-v${version}`;
  let existing = releases.find((release) => release.tag_name === tag);

  if (existing && !existing.draft) {
    if (existing.prerelease)
      throw new Error(`Refusing to replace prerelease ${tag}`);
    await downloadRelease(repo, existing);
    console.log(`${tag} is already published; leaving its assets unchanged.`);

    return;
  }

  const directory = await exportBundle();
  await verifyBundle(directory);

  const commit = (
    await Bun.file(join(directory, "source-commit.txt")).text()
  ).trim();

  if (commit !== process.env["GITHUB_SHA"])
    throw new Error("Checkout differs from the workflow source commit");
  await assertTagTarget(repo, tag, commit);

  if (existing) {
    if (existing.target_commitish !== commit || existing.prerelease)
      throw new Error(
        "Draft belongs to a different source commit or prerelease",
      );
  } else {
    existing = releaseSchema.parse(
      JSON.parse(
        gh([
          "api",
          "--method",
          "POST",
          `repos/${repo}/releases`,
          "-f",
          `tag_name=${tag}`,
          "-f",
          `target_commitish=${commit}`,
          "-f",
          `name=${tag}`,
          "-F",
          "draft=true",
          "-F",
          "prerelease=false",
          "-f",
          `body=${await Bun.file(join(directory, "CHANGELOG.md")).text()}`,
        ]),
      ),
    );
  }

  const downloaded = await mkdtemp(join(tmpdir(), "crumble-draft-"));

  for (const name of [...payloadNamesOf(schemaNames), "SHA256SUMS"]) {
    if (existing.assets.some((asset) => asset.name === name)) {
      gh([
        "release",
        "download",
        tag,
        "--repo",
        repo,
        "--pattern",
        name,
        "--dir",
        downloaded,
      ]);

      if (
        !Buffer.from(
          await Bun.file(join(downloaded, name)).arrayBuffer(),
        ).equals(
          Buffer.from(await Bun.file(join(directory, name)).arrayBuffer()),
        )
      ) {
        throw new Error(
          `Existing draft asset differs: ${name}; refusing to overwrite`,
        );
      }
    } else {
      gh(["release", "upload", tag, join(directory, name), "--repo", repo]);
    }
  }

  await assertTagTarget(repo, tag, commit);
  gh([
    "release",
    "edit",
    tag,
    "--repo",
    repo,
    "--draft=false",
    "--target",
    commit,
    "--latest=false",
  ]);
  console.log(`Published ${tag} from ${commit}`);
}

if (import.meta.main) {
  const [command, ...args] = Bun.argv.slice(2);
  const current = resolve(process.env["CONTRACT_DIR"] ?? "openapi");

  const reports = resolve(
    process.env["CONTRACT_REPORTS"] ?? "contract-reports",
  );

  const repo = process.env["GITHUB_REPOSITORY"] ?? "crumble-project/bot";

  if (command === "validate" && args.length <= 1) {
    await validateContract(resolve(args[0] ?? current));
  } else if (command === "compatibility" && args.length <= 1) {
    await validateContract(current);

    if (args[0]) await compareContracts(resolve(args[0]), current, reports);
    else await checkPublished(repo, current, reports);
  } else if (command === "publish" && args.length === 0) {
    await publish(repo, current, reports);
  } else {
    throw new Error(
      "Usage: bun apps/server/src/contract-release.ts validate [DIRECTORY] | compatibility [BASELINE_DIRECTORY] | publish",
    );
  }
}
