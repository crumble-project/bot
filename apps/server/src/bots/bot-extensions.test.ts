import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineExtension } from "@earendil-works/pi-durable";
import { Effect, Exit, Scope } from "effect";
import { agentInput } from "../shared/domain";
import { Store } from "../shared/store";
import { BotExtensions } from "./bot-extensions";

const dir = mkdtempSync(join(tmpdir(), "crumble-extensions-"));
const store = new Store(dir);
const agent = store.createAgent(agentInput.parse({ name: "Bot" }));

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const named = (name: string) => defineExtension({ name });

test("extensions come in position order, whatever order features registered in", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const extensions = yield* BotExtensions;
      const late = yield* Scope.make();

      yield* extensions.register(30, () => [named("third")]);
      yield* extensions
        .register(10, async () => [named("first")])
        .pipe(Scope.provide(late));
      yield* extensions.register(20, () => [named("second")]);

      expect(
        (yield* Effect.promise(() => extensions.forAgent(agent))).map(
          (extension) => extension.name,
        ),
      ).toEqual(["first", "second", "third"]);

      // A feature's scope ends: its extensions are no longer offered.
      yield* Scope.close(late, Exit.void);

      expect(
        (yield* Effect.promise(() => extensions.forAgent(agent))).map(
          (extension) => extension.name,
        ),
      ).toEqual(["second", "third"]);
    }).pipe(Effect.scoped, Effect.provide(BotExtensions.layer)),
  );
});
