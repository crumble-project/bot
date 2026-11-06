import { expect, test } from "bun:test";
import { Effect } from "effect";
import { startTicking } from "./ticker";

test("a tick that dies leaves the loop running", async () => {
  let ticks = 0;

  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;

      yield* startTicking(
        Effect.sync(() => {
          ticks += 1;

          if (ticks === 1) throw new Error("database is locked");
        }),
        scope,
      );
      yield* Effect.promise(() => Bun.sleep(1100));
    }).pipe(Effect.scoped),
  );

  expect(ticks).toBeGreaterThan(1);
}, 5000);
