import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020";
import { z } from "zod";
import { openAPIDocument } from "./api-contract";

const isEventSchema = (name: string) => name.endsWith(".schema.json");

export async function eventSchemaNames(directory: string) {
  return (await readdir(directory)).filter(isEventSchema).sort();
}

const documentSchema = z.looseObject({
  info: z.looseObject({ version: z.string().min(1) }),
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

  if (run([tool, "--version"]).trim() !== "oasdiff version 1.35.0") {
    throw new Error("Compatibility requires official oasdiff 1.35.0");
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

  const baseNames = await eventSchemaNames(baseline);
  const currentNames = await eventSchemaNames(current);
  const removed = baseNames.filter((name) => !currentNames.includes(name));

  if (removed.length > 0) breaking = true;

  if (breaking) {
    throw new Error(
      `Breaking HTTP or event changes detected${removed.length ? `; removed event schemas: ${removed.join(", ")}` : ""}. See compatibility reports.`,
    );
  }

  console.log("Compatibility passed against the baseline");
}

if (import.meta.main) {
  const [command, ...args] = Bun.argv.slice(2);
  const current = resolve(process.env["CONTRACT_DIR"] ?? "openapi");

  const reports = resolve(
    process.env["CONTRACT_REPORTS"] ?? "contract-reports",
  );

  if (command === "validate" && args.length <= 1) {
    await validateContract(resolve(args[0] ?? current));
  } else if (command === "compatibility" && args.length === 1) {
    await compareContracts(resolve(args[0]!), current, reports);
  } else {
    throw new Error(
      "Usage: bun apps/server/src/contract/contract-check.ts validate [DIRECTORY] | compatibility BASELINE_DIRECTORY",
    );
  }
}
