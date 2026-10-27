import { expect, test } from "bun:test";
import {
  exclusiveKind,
  open,
  until,
  SETTLE_MS,
  SETTLING_TEST_MS,
} from "./jobs-test-support";

test(
  "stopping a waiting job cancels its delivery",
  async () => {
    const { gates, say } = await open(exclusiveKind);

    await say("start a");
    await until(() => gates.started.includes("a"));
    await say("start b");
    await say("stop b");

    gates.release("a");
    await Bun.sleep(SETTLE_MS);
    expect(gates.started).toEqual(["a"]);
  },
  SETTLING_TEST_MS,
);
