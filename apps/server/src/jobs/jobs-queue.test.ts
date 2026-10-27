import { expect, test } from "bun:test";
import {
  exclusiveKind,
  open,
  until,
  SETTLE_MS,
  SETTLING_TEST_MS,
} from "./jobs-test-support";

test(
  "waiting jobs start one at a time when the screen frees up",
  async () => {
    const { gates, say } = await open(exclusiveKind);

    await say("start a");
    await until(() => gates.started.includes("a"));
    await say("start b");
    await say("start c");

    gates.release("a");
    await until(() => gates.started.length === 2);
    await Bun.sleep(SETTLE_MS);
    // Only one of b and c holds the screen.
    expect(gates.started).toHaveLength(2);

    const second = gates.started[1]!;
    gates.release(second);
    await until(() => gates.started.length === 3);
    gates.release(gates.started[2]!);
  },
  SETTLING_TEST_MS,
);
