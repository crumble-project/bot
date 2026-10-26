import { describe, expect, test } from "bun:test";
import { isPortConflict } from "./provider-auth";

const addressInUse = () =>
  Object.assign(new Error("listen failed"), { code: "EADDRINUSE" });

describe("callback port conflicts", () => {
  test("recognizes the system's address-in-use error", () => {
    expect(isPortConflict(addressInUse())).toBe(true);
  });

  test("recognizes a provider message that names the port", () => {
    expect(
      isPortConflict(new Error("Failed to start server: port 1455 is in use")),
    ).toBe(true);
  });

  test("follows the cause chain to the error that carries the conflict", () => {
    const wrapped = new Error("Login failed", {
      cause: new Error("Callback server failed", { cause: addressInUse() }),
    });

    expect(isPortConflict(wrapped)).toBe(true);
  });

  test("reports other failures as provider failures", () => {
    expect(isPortConflict(new Error("invalid_grant"))).toBe(false);
    expect(
      isPortConflict(new Error("Login failed", { cause: "offline" })),
    ).toBe(false);
  });
});
