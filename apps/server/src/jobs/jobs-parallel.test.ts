import { test } from "bun:test";
import { parallelKind, open, until } from "./jobs-test-support";

test("jobs of other kinds run side by side", async () => {
  const { gates, say } = await open(parallelKind);

  await say("start a");
  await say("start b");
  await until(() => gates.started.includes("b"));
  gates.release("a");
  gates.release("b");
});
