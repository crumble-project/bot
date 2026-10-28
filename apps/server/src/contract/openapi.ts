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
