import { describe, expect, test } from "bun:test";
import { serialNumber } from "./credential-authority";

describe("serialNumber", () => {
  test("encodes a positive DER integer without a leading zero byte", () => {
    for (const first of [0x00, 0x7f, 0x80, 0xff]) {
      const bytes = new Uint8Array(16).fill(0x22);
      bytes[0] = first;

      const der = new Uint8Array(serialNumber(bytes).toBER(false));

      expect(der[1]).toBe(16);
      expect(der[2]).toBeGreaterThan(0);
      expect(der[2]).toBeLessThan(0x80);
    }
  });
});
