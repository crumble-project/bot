import { z } from "zod";
import { openAPIDocument } from "./api-contract";
import { eventSchemas } from "./api-responses";

type ContractArtifacts = Record<string, string>;

export function contractArtifacts() {
  const artifacts: ContractArtifacts = {};
  artifacts["openapi.json"] = `${JSON.stringify(openAPIDocument(), null, 2)}\n`;

  for (const { artifact, schema } of eventSchemas) {
    if (!artifact) continue;

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

    artifacts[artifact] = `${JSON.stringify(document, null, 2)}\n`;
  }

  return artifacts;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || (args.length === 1 && args[0] === "--check")) {
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
    console.error("Usage: bun apps/server/src/contract/openapi.ts [--check]");
    process.exitCode = 1;
  }
}
