import { expect } from "bun:test";
import { sleep } from "../../src/shared/time";

export async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 10_000;

  while (!(await check()) && performance.now() < deadline) await sleep(10);

  expect(await check()).toBe(true);
}
