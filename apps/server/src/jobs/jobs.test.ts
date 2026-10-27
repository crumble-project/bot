import { expect, test } from "bun:test";
import {
  exclusiveKind,
  open,
  until,
  SETTLE_MS,
  SETTLING_TEST_MS,
} from "./jobs-test-support";

test(
  "an exclusive job waits while another job of its kind works",
  async () => {
    const { gates, say } = await open(exclusiveKind);

    await say("start a");
    await until(() => gates.started.includes("a"));
    await say("start b");

    await Bun.sleep(SETTLE_MS);
    expect(gates.started).toEqual(["a"]);

    gates.release("a");
    await until(() => gates.started.includes("b"));
    gates.release("b");
  },
  SETTLING_TEST_MS,
);
