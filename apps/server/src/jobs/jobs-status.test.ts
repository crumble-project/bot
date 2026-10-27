import { expect, test } from "bun:test";
import { exclusiveKind, open, until } from "./jobs-test-support";

test("a job waiting for the screen reports as working", async () => {
  const { gates, say, lastToolResult } = await open(exclusiveKind);

  await say("start a");
  await until(() => gates.started.includes("a"));
  await say("start b");
  await say("status b");

  expect(await lastToolResult()).toBe("b: working");
  gates.release("a");
  await until(() => gates.started.includes("b"));
  gates.release("b");
});
