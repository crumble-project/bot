import { expect, test } from "bun:test";
import { parallelKind, open, until } from "./jobs-test-support";

test("jobs of other kinds run side by side", async () => {
  const { gates, say } = await open(parallelKind);

  await say("start a");
  await say("start b");
  await until(() => gates.started.includes("b"));
  gates.release("a");
  gates.release("b");
});

test("a job's report reaches the owner whatever its name holds", async () => {
  const { gates, say, messages } = await open(parallelKind);

  await say("start a]b");
  await until(() => gates.started.includes("a]b"));
  gates.release("a]b");

  for (let tries = 0; tries < 500; tries++) {
    if ((await messages()).some((message) => message.origin?.name === "a]b"))
      break;

    await Bun.sleep(20);
  }

  expect(
    (await messages()).find((message) => message.origin?.name === "a]b")
      ?.content,
  ).toBe("a]b done");
});
