import { expect, mock, test } from "bun:test";
import { Effect, Redacted, Result } from "effect";

const VALUES = new Map([["6f1d2c3e-1b2a-4c5d-8e9f-0a1b2c3d4e5f", "hunter2"]]);

// Answers with lowercase IDs whatever case was asked for; the real SDK's casing is unverified.
class BitwardenClient {
  auth() {
    return { loginAccessToken: async () => undefined };
  }

  secrets() {
    return {
      getByIds: async (ids: string[]) => ({
        data: ids.flatMap((requested) => {
          const id = requested.toLowerCase();
          const value = VALUES.get(id);

          return value === undefined ? [] : [{ id, value }];
        }),
      }),
    };
  }
}

await mock.module("@bitwarden/sdk-napi", () => ({ BitwardenClient }));

const { bitwarden } = await import("./bitwarden");

test("reads a reference in any case and keys the result by the reference as given", async () => {
  const reference = "6F1D2C3E-1B2A-4C5D-8E9F-0A1B2C3D4E5F";

  const reads = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* bitwarden.signIn(Redacted.make("token"));

      return yield* client.read([reference]);
    }),
  );

  const read = reads.get(reference);

  expect(read && Result.isSuccess(read) && Redacted.value(read.success)).toBe(
    "hunter2",
  );
});
