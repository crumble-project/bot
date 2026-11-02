import { describe, expect, test } from "bun:test";
import { serialNumber } from "./credential-authority";

describe("serialNumber", () => {
  test("encodes a positive DER integer without a leading zero byte", () => {
    for (const [first, encoded] of [
      [0x00, 0x40],
      [0x7f, 0x7f],
      [0x80, 0x40],
      [0xff, 0x7f],
    ] as const) {
      const bytes = new Uint8Array(16).fill(0x22);
      bytes[0] = first;

      const der = new Uint8Array(serialNumber(bytes).toBER(false));

      expect([...der]).toEqual([0x02, 16, encoded, ...Array(15).fill(0x22)]);
    }
  });
});
