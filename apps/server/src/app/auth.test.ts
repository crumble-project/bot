import { expect, test } from "bun:test";
import { passkeyOriginFor } from "./auth";

test("binds passkeys to localhost for a loopback origin", () => {
  expect(passkeyOriginFor("http://127.0.0.1:7337")).toBe(
    "http://localhost:7337",
  );
  expect(passkeyOriginFor("http://[::1]:7337")).toBe("http://localhost:7337");
});

test("binds passkeys to a hostname origin as given", () => {
  expect(passkeyOriginFor("https://crumble.tailnet.ts.net")).toBe(
    "https://crumble.tailnet.ts.net",
  );
  expect(passkeyOriginFor("http://localhost:7337")).toBe(
    "http://localhost:7337",
  );
});
