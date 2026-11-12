import { z } from "zod";
import { openAPIDocument } from "./api-contract";
import { eventSchemas } from "./api-responses";

type ContractArtifacts = Record<string, string>;

const stringPropertyNames = z.object({ type: z.literal("string") }).strict();

export function contractArtifacts() {
  const artifacts: ContractArtifacts = {};
  artifacts["openapi.json"] = `${JSON.stringify(openAPIDocument(), null, 2)}\n`;

  for (const { artifact, schema } of eventSchemas) {
    if (!artifact) continue;

    const document = z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io: "output",
      override: ({ jsonSchema }) => {
        if (stringPropertyNames.safeParse(jsonSchema.propertyNames).success)
          delete jsonSchema.propertyNames;

        if (
          jsonSchema.type === "object" &&
          jsonSchema.additionalProperties === false
        )
          jsonSchema.additionalProperties = true;
      },
    });

    artifacts[artifact] = `${JSON.stringify(document, null, 2)}\n`;
  }

  return artifacts;
}

const artifactTarget = (name: string) =>
  new URL(`../../../../openapi/${name}`, import.meta.url);

async function checkArtifacts() {
  let stale = false;

  for (const [name, content] of Object.entries(contractArtifacts())) {
    const target = artifactTarget(name);

    if (
      !(await Bun.file(target).exists()) ||
      (await Bun.file(target).text()) !== content
    ) {
      console.error(
        `Stale contract artifact: openapi/${name}. Run bun run openapi:generate.`,
      );
      stale = true;
    }
  }

  return stale;
}

async function writeArtifacts() {
  for (const [name, content] of Object.entries(contractArtifacts())) {
    await Bun.write(artifactTarget(name), content);
    console.log(`Generated openapi/${name}`);
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const checking = args[0] === "--check";

  if (args.length > 1 || (args.length === 1 && !checking)) {
    console.error("Usage: bun apps/server/src/contract/openapi.ts [--check]");
    process.exitCode = 1;
  } else if (checking) {
    if (await checkArtifacts()) process.exitCode = 1;
  } else {
    await writeArtifacts();
  }
}
